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
// tag="trooth-connector". The key is generated once per store with
// generateConnectorKey() and its public half is pasted into the Trooth
// dashboard; the private half never leaves the store's server.
//
// Runs in Node 20 or newer and in any runtime with WebCrypto Ed25519.

const enc = new TextEncoder();

export const CONNECTOR_TAG = "trooth-connector";
export const CONNECTOR_COMPONENTS = ["@method", "@target-uri", "content-digest", "content-type"];

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
export async function signPost({ url, body, contentType = "application/json", privateJwk, created = Math.floor(Date.now() / 1000), ttlSeconds = 300, label = "sig1" }) {
  const bodyBytes = typeof body === "string" ? enc.encode(body) : body;
  const digest = await contentDigest(bodyBytes);
  const u = new URL(url);
  const params = `;created=${created};expires=${created + ttlSeconds};keyid=${sfString(privateJwk.kid)};alg="ed25519";tag=${sfString(CONNECTOR_TAG)}`;
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

/** POST a JSON document, signed. Returns the Response. */
export async function postSigned({ url, document, privateJwk, fetchImpl = globalThis.fetch }) {
  const body = JSON.stringify(document);
  const headers = await signPost({ url, body, privateJwk });
  return fetchImpl(url, { method: "POST", headers, body });
}
