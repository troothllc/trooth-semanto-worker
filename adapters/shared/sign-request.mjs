// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Signed POSTs from a commerce connector (Shopify, BigCommerce, Salesforce
// Commerce, WooCommerce) to the Trooth API: RFC 9421 HTTP Message Signatures
// with an RFC 9530 Content-Digest, Ed25519 only, through WebCrypto. It builds
// the same signature base as src/core/httpsig.ts so the API verifies it with
// the code it already has, and it is tested against that code.
//
// Covered components: "@method" "@target-uri" "content-digest" "content-type".
// Parameters: created, expires, keyid (the RFC 7638 thumbprint), alg="ed25519",
// nonce (fresh per request; the API claims it once, so a captured request
// cannot be replayed), tag="trooth-connector". The key is generated once per
// store with generateConnectorKey() and its public half is pasted into the
// Trooth dashboard; the private half never leaves the store's server.
//
// signForwarding() is the same key on a host adapter: when a reader's request
// carries a Web Bot Auth signature, the adapter forwards it to the API and
// vouches for the customer host the reader addressed and the client address
// it saw (Trooth-Forwarded-Authority, Trooth-Forwarded-For), signing @method,
// @target-uri, those two fields and the reader's Signature, Signature-Input
// and Signature-Agent fields whole. Its own signature goes in
// Trooth-Connector-Signature-Input and Trooth-Connector-Signature, because
// the Signature fields carry the reader's (src/readers/forwarded.ts).
//
// Runs in Node 20 or newer and in any runtime with WebCrypto Ed25519.

const enc = new TextEncoder();

export const CONNECTOR_TAG = "trooth-connector";
export const CONNECTOR_COMPONENTS = ["@method", "@target-uri", "content-digest", "content-type"];
export const FORWARDING_COMPONENTS = ["@method", "@target-uri", "trooth-forwarded-authority", "trooth-forwarded-for", "signature", "signature-input", "signature-agent"];

/** A fresh nonce: 16 random bytes, base64url. */
export function randomNonce() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

function b64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** RFC 7638 thumbprint of an Ed25519 public JWK: canonical {"crv","kty","x"}. */
export async function thumbprint(jwk) {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  return b64url(await sha256(enc.encode(canonical)));
}

export async function generateConnectorKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const kid = await thumbprint({ x: pub.x });
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x, kid, alg: "EdDSA", use: "sig" };
  return { publicJwk, privateJwk: { ...publicJwk, d: priv.d } };
}

export async function contentDigest(bodyBytes) {
  return `sha-256=:${b64(await sha256(bodyBytes))}:`;
}

function sfString(s) {
  if (/[^\x20-\x7e]/.test(s)) throw new Error("sfString: non-ASCII");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Sign a POST. Returns the headers to send: Content-Type, Content-Digest,
 * Signature-Input and Signature. `body` is a string or Uint8Array.
 */
export async function signPost({ url, body, contentType = "application/json", privateJwk, created = Math.floor(Date.now() / 1000), ttlSeconds = 300, label = "sig1", nonce = randomNonce() }) {
  const bodyBytes = typeof body === "string" ? enc.encode(body) : body;
  const digest = await contentDigest(bodyBytes);
  const u = new URL(url);
  const params = `;created=${created};expires=${created + ttlSeconds};keyid=${sfString(privateJwk.kid)};alg="ed25519";nonce=${sfString(nonce)};tag=${sfString(CONNECTOR_TAG)}`;
  const inner = `(${CONNECTOR_COMPONENTS.map(sfString).join(" ")})${params}`;
  const lines = [
    `"@method": POST`,
    `"@target-uri": ${u.href}`,
    `"content-digest": ${digest}`,
    `"content-type": ${contentType}`,
    `"@signature-params": ${inner}`,
  ];
  const base = lines.join("\n");
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d }, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(base)));
  return {
    "Content-Type": contentType,
    "Content-Digest": digest,
    "Signature-Input": `${label}=${inner}`,
    Signature: `${label}=:${b64(sig)}:`,
  };
}

/** RFC 9421 2.1: a field's value with obs-fold collapsed and the ends trimmed. */
const canonField = (v) => String(v).replace(/[\r\n]+[ \t]+/g, " ").trim();

/**
 * Sign a forwarding request from a host adapter to the API. `headers` must
 * already hold Trooth-Forwarded-Authority, Trooth-Forwarded-For and the
 * reader's Signature, Signature-Input and Signature-Agent. Returns the two
 * Trooth-Connector-Signature fields to add.
 */
export async function signForwarding({ method = "GET", url, headers, privateJwk, created = Math.floor(Date.now() / 1000), ttlSeconds = 300, label = "adapter", nonce = randomNonce() }) {
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === name) ?? ""]);
  const params = `;created=${created};expires=${created + ttlSeconds};keyid=${sfString(privateJwk.kid)};alg="ed25519";nonce=${sfString(nonce)};tag=${sfString(CONNECTOR_TAG)}`;
  const inner = `(${FORWARDING_COMPONENTS.map(sfString).join(" ")})${params}`;
  const lines = [`"@method": ${method.toUpperCase()}`, `"@target-uri": ${new URL(url).href}`];
  for (const name of FORWARDING_COMPONENTS.slice(2)) {
    const v = get(name);
    if (v === null || v === undefined) throw new Error(`signForwarding: ${name} is missing`);
    lines.push(`${sfString(name)}: ${canonField(v)}`);
  }
  lines.push(`"@signature-params": ${inner}`);
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d }, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(lines.join("\n"))));
  return {
    "Trooth-Connector-Signature-Input": `${label}=${inner}`,
    "Trooth-Connector-Signature": `${label}=:${b64(sig)}:`,
  };
}

/** POST a JSON document, signed. Returns the Response. */
export async function postSigned({ url, document, privateJwk, fetchImpl = globalThis.fetch }) {
  const body = JSON.stringify(document);
  const headers = await signPost({ url, body, privateJwk });
  return fetchImpl(url, { method: "POST", headers, body });
}
