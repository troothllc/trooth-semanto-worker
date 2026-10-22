// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto verifier for JavaScript: one ES module, no dependencies, runs in
// Node 20+ and in browsers on WebCrypto alone. It re-implements, rather than
// imports, everything it needs, so the kit stands on its own and a reader who
// distrusts Trooth's code can read this one file:
//
//   RFC 8785  canonical JSON (what every Semanto hash and signature is over)
//   SHA-256   through crypto.subtle; every digest is "sha256:" plus 64 hex
//   RFC 6962  Merkle leaf and node hashing, inclusion and consistency proofs
//   RFC 7515  JWS compact serialization with RFC 8037 EdDSA (Ed25519)
//   RFC 9421  HTTP message signatures over a response, with RFC 9530 Content-Digest
//   C2SP      the checkpoint (signed note) format transparency logs share
//
// Every function returns plain data: { ok, reason, checks } where `checks` is a
// list of { name, ok, detail } in plain words, so a CLI or a web page can print
// exactly what was checked. Nothing here produces a number or a verdict about a
// company; it says whether the bytes match the signatures.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const JWS_TYPES = {
  semantoVersion: "https://trooth.co/types/semanto-version",
  witness: "https://trooth.co/types/witness-statement",
  receipt: "https://trooth.co/types/coverage-receipt",
  treeHead: "https://trooth.co/types/signed-tree-head",
  offer: "https://trooth.co/types/signed-offer",
  productRecord: "https://trooth.co/types/product-record",
  sellerAttestation: "https://trooth.co/types/seller-attestation",
  recall: "https://trooth.co/types/recall-notice",
  marketplaceCatalog: "https://trooth.co/types/marketplace-catalog",
  firstPublication: "https://trooth.co/types/first-publication",
  readReceipt: "https://trooth.co/types/read-receipt",
  revocation: "https://trooth.co/types/revocation-list",
  contentSignals: "https://trooth.co/types/content-signals",
};

export const SEMANTO_RESPONSE_COMPONENTS = ["@status", "content-type", "content-digest", "trooth-semanto-version", "trooth-page-hash"];
/** Covered whenever the response carries them; the Trooth ones and Location must be covered when present. */
export const SEMANTO_RESPONSE_OPTIONAL_COMPONENTS = ["trooth-signed-page-hash", "trooth-signed-by", "trooth-semanto-state", "location", "content-signal", "link"];
export const SEMANTO_RESPONSE_MUST_COVER_WHEN_PRESENT = ["trooth-signed-page-hash", "trooth-signed-by", "trooth-semanto-state", "location"];
/** Trooth's log: the checkpoint signer name and origin a Trooth checkpoint must carry. */
export const TROOTH_LOG_SIGNER_NAME = "trooth.co";
export const TROOTH_LOG_ORIGIN = "trooth.co/semanto/log/v1";
export const SEMANTO_RESPONSE_TAG = "trooth-semanto";
export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// ------------------------------------------------------------------ bytes

export const utf8 = (s) => encoder.encode(s);
export const fromUtf8 = (b) => decoder.decode(b);

export function toHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex) {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(b) {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

export function fromBase64(s) {
  const clean = s.replace(/[\s=]+$/g, "").replace(/\s+/g, "");
  const bytes = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("not base64");
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

export const toBase64Url = (b) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromBase64Url(s) {
  if (/[^A-Za-z0-9_-]/.test(s)) throw new Error("not base64url");
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/"));
}

export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ------------------------------------------------------------------ RFC 8785

export function canonicalize(v) {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalize: non-finite number");
    return Object.is(v, -0) ? "0" : String(v);
  }
  if (typeof v === "string") return jsonString(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x === undefined ? null : x)).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort(cmpUtf16);
    return `{${keys.map((k) => `${jsonString(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalize: cannot serialize ${typeof v}`);
}

function cmpUtf16(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function jsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  return out + '"';
}

// ------------------------------------------------------------------ SHA-256

export async function sha256(data) {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(data) {
  return toHex(await sha256(data));
}

export async function digest(data) {
  return `sha256:${await sha256Hex(data)}`;
}

export const isDigest = (v) => typeof v === "string" && DIGEST_RE.test(v);

export function digestBytes(d) {
  if (!isDigest(d)) throw new Error(`expected "sha256:<64 hex>", got ${JSON.stringify(d)}`);
  return fromHex(d.slice(7));
}

// ------------------------------------------------------------------ ids

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function semantoId(prefix, d) {
  if (!isDigest(d)) throw new Error("semantoId needs a digest");
  let bits = "";
  for (const ch of d.slice(7)) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length && out.length < 26; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return `${prefix}_${out}`;
}

// ------------------------------------------------------------------ RFC 6962

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export const leafHash = (data) => sha256(concat(LEAF, data));
export const nodeHash = (l, r) => sha256(concat(NODE, l, r));

function largestPowerOfTwoBelow(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export async function rootFromLeafHashes(leaves) {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0];
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(await rootFromLeafHashes(leaves.slice(0, k)), await rootFromLeafHashes(leaves.slice(k)));
}

/** RFC 6962 2.1.3: recompute the root from a leaf hash and its audit path. */
export async function verifyInclusion(leaf, index, size, proof, expectedRoot) {
  if (index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      while (!(fn % 2 === 1 || fn === 0)) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(r, expectedRoot);
}

/** RFC 6962 2.1.4.2: the old tree is a prefix of the new tree. */
export async function verifyConsistencyProof(oldSize, newSize, oldRoot, newRoot, proof) {
  if (oldSize > newSize) return false;
  if (oldSize === newSize) return proof.length === 0 && bytesEqual(oldRoot, newRoot);
  if (oldSize === 0) return proof.length === 0;
  const isPow2 = (oldSize & (oldSize - 1)) === 0;
  const p = isPow2 ? [oldRoot, ...proof] : [...proof];
  if (p.length === 0) return false;
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = p[0];
  let sr = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (!(fn % 2 === 1 || fn === 0)) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(fr, oldRoot) && bytesEqual(sr, newRoot);
}

// ------------------------------------------------------------------ keys

export async function importPublic(jwk) {
  return subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
}

export async function ed25519Verify(jwk, signature, data) {
  try {
    return await subtle.verify({ name: "Ed25519" }, await importPublic(jwk), signature, data);
  } catch {
    return false;
  }
}

/** RFC 7638 thumbprint of an OKP key: the kid every Semanto key uses. */
export async function thumbprint(jwk) {
  return toBase64Url(await sha256(utf8(canonicalize({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))));
}

function collectJwks(keys, all) {
  const add = (k) => {
    if (!k) return;
    if (Array.isArray(k)) return k.forEach(add);
    if (Array.isArray(k.keys)) return k.keys.forEach((j) => all.push(j));
    if (k.jwks) return add(k.jwks);
    if (k.kty === "OKP") return all.push(k);
    if (typeof k === "object") Object.values(k).forEach(add);
  };
  add(keys);
  return all;
}

const ROLE_NAMES = ["company", "trooth", "agent"];

/** True when `keys` names its sets by role ({ company, trooth, agent }, the keys.json vector shape). */
export function hasRoles(keys) {
  return !!keys && typeof keys === "object" && !Array.isArray(keys) && ROLE_NAMES.some((r) => keys[r] !== undefined);
}

/**
 * The keys for one role. Company signatures resolve only against the
 * company's set (its domain JWKS); witness statements, tree heads,
 * checkpoints and revocation lists only against Trooth's; Web Bot Auth
 * requests only against the agent's directory. When `keys` is role-shaped,
 * only that role's set is returned. When it is a plain JWK Set (no roles),
 * the caller chose exactly these keys for this one check and they are used
 * as given; functions that check two roles at once (verifySemanto,
 * verifyPageProof) treat a plain set as the company's only.
 */
export function roleKeys(keys, role) {
  if (hasRoles(keys)) return collectJwks(keys[role], []);
  return collectJwks(keys, []);
}

function resolverOf(list) {
  return (kid) => list.find((j) => j.kid === kid && j.kty === "OKP" && j.crv === "Ed25519") ?? null;
}

/** A resolver over one role's keys (see roleKeys). */
export function roleResolver(keys, role) {
  return resolverOf(roleKeys(keys, role));
}

/** For checks of two roles at once: a plain set is the company's, and Trooth's is then empty. */
function strictRoleResolver(keys, role) {
  if (hasRoles(keys)) return roleResolver(keys, role);
  return role === "company" ? resolverOf(collectJwks(keys, [])) : () => null;
}

/**
 * Build a key resolver over every key in `keys`, whatever its role. Use it
 * only where the role does not matter; the top-level checks use roleResolver.
 */
export function keyResolver(keys) {
  return resolverOf(collectJwks(keys, []));
}

/** Is this key valid at `at`? (The window only; signature checks use keyValidAtSigning.) */
export function keyValidAt(jwk, at) {
  const t = at.getTime();
  if (jwk.nbf && t < Date.parse(jwk.nbf)) return { ok: false, reason: "key_not_yet_valid" };
  if (jwk.exp && t >= Date.parse(jwk.exp)) return { ok: false, reason: "key_expired" };
  if (jwk.revoked_at && t >= Date.parse(jwk.revoked_at)) return { ok: false, reason: "key_revoked" };
  return { ok: true };
}

/** An ISO 8601 instant: absent is null, present must parse ("bad" otherwise). */
function instant(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return "bad";
  const t = Date.parse(v);
  return Number.isNaN(t) ? "bad" : t;
}

/**
 * Key validity when the statement was signed (iat in ms), not when it is
 * checked: a key valid at iat verifies after rotation; a key revoked at or
 * before iat fails; a key revoked after iat verifies with a note
 * "key revoked after signing on <date>". Revocation for compromise backdates
 * revoked_at to the compromise, which invalidates later signatures.
 */
export function keyValidAtSigning(jwk, iatMs) {
  const nbf = instant(jwk.nbf);
  const exp = instant(jwk.exp);
  const rev = instant(jwk.revoked_at);
  if (nbf === "bad" || exp === "bad" || rev === "bad") return { ok: false, reason: "malformed" };
  if (nbf !== null && iatMs < nbf) return { ok: false, reason: "key_not_yet_valid" };
  if (exp !== null && iatMs >= exp) return { ok: false, reason: "key_expired" };
  if (rev !== null && iatMs >= rev) return { ok: false, reason: "key_revoked" };
  return { ok: true, notes: rev !== null ? [`key revoked after signing on ${jwk.revoked_at}`] : [] };
}

export function parseDnsKeyRecords(txt) {
  const kids = [];
  for (const t of txt) {
    const m = /^v=trooth1;\s*kid=([A-Za-z0-9_-]{43})$/.exec(String(t).trim().replace(/^"|"$/g, ""));
    if (m) kids.push(m[1]);
  }
  return kids;
}

// ------------------------------------------------------------------ JWS

/**
 * Verify a compact (h.p.s) or detached (h..s) JWS. When opts.payload is
 * given, the JWS payload segment must be empty or byte-equal to
 * base64url(RFC 8785 bytes of opts.payload); anything else is
 * "payload_mismatch" (a detached signature plus the public old payload must
 * never verify a new object). Without opts.payload the embedded payload is
 * returned and the caller compares it with what it meant to check. The key
 * is judged at the statement's iat (keyValidAtSigning); nbf and exp at
 * opts.at. Returns { ok, header, payload, notes } or { ok: false, reason }.
 */
export async function verifyJws(jws, resolveKey, opts = {}) {
  if (typeof jws !== "string") return { ok: false, reason: "malformed" };
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, pGiven, s] = parts;
  let header;
  try {
    header = JSON.parse(fromUtf8(fromBase64Url(h)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return { ok: false, reason: "malformed" };
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  if (opts.expectTyp && header.typ !== opts.expectTyp) return { ok: false, reason: "wrong_type" };
  const iat = instant(header.iat);
  const nbf = instant(header.nbf);
  const exp = instant(header.exp);
  if (iat === "bad" || nbf === "bad" || exp === "bad") return { ok: false, reason: "malformed" };
  let p;
  if (opts.payload !== undefined) {
    let expected;
    try {
      expected = toBase64Url(utf8(canonicalize(opts.payload)));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (pGiven !== "" && pGiven !== expected) return { ok: false, reason: "payload_mismatch" };
    p = expected;
  } else {
    if (pGiven === "") return { ok: false, reason: "malformed" };
    p = pGiven;
  }
  const jwk = await resolveKey(header.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  let sig;
  try {
    sig = fromBase64Url(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!(await ed25519Verify(jwk, sig, utf8(`${h}.${p}`)))) return { ok: false, reason: "bad_signature" };
  const t = (opts.at ?? new Date()).getTime();
  const kv = keyValidAtSigning(jwk, iat ?? t);
  if (!kv.ok) return { ok: false, reason: kv.reason };
  if (nbf !== null && t < nbf) return { ok: false, reason: "not_yet_valid" };
  if (exp !== null && t >= exp) return { ok: false, reason: "expired" };
  let payload;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(p)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, header, payload, notes: kv.notes };
}

// ------------------------------------------------------------------ RFC 9421

function headerGet(headers, name) {
  const n = name.toLowerCase();
  if (headers && typeof headers.get === "function") return headers.get(n);
  const k = Object.keys(headers).find((x) => x.toLowerCase() === n);
  if (!k) return null;
  const v = headers[k];
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v.map((x) => x.trim()).join(", ") : String(v);
}

const canonField = (v) => v.replace(/[\r\n]+[ \t]+/g, " ").trim();

function sfString(s) {
  if (/[^\x20-\x7e]/.test(s)) throw new Error("non-ASCII in structured field string");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function derived(name, m) {
  const u = m.url ? new URL(m.url) : null;
  switch (name) {
    case "@method":
      if (m.kind !== "request" || !m.method) throw new Error("@method needs a request");
      return m.method.toUpperCase();
    case "@target-uri":
      if (!u) throw new Error("@target-uri needs a url");
      return u.href;
    case "@authority":
      if (!u) throw new Error("@authority needs a url");
      return u.host.toLowerCase();
    case "@scheme":
      if (!u) throw new Error("@scheme needs a url");
      return u.protocol.replace(/:$/, "").toLowerCase();
    case "@path":
      if (!u) throw new Error("@path needs a url");
      return u.pathname;
    case "@query":
      if (!u) throw new Error("@query needs a url");
      return u.search === "" ? "?" : u.search;
    case "@status":
      if (m.kind !== "response" || m.status === undefined) throw new Error("@status needs a response");
      return String(m.status);
    default:
      throw new Error(`unsupported derived component ${name}`);
  }
}

export function parseSignatureInput(value) {
  const out = {};
  const re = /([A-Za-z0-9_*.-]+)=\(((?:\s*"(?:[^"\\]|\\.)*")*)\s*\)((?:;[A-Za-z*][A-Za-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))?)*)/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const label = m[1];
    const components = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, "$1"));
    const params = {};
    for (const pm of m[3].matchAll(/;([A-Za-z*][A-Za-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|[^;,\s]+))?/g)) {
      const k = pm[1];
      const v = pm[2] === undefined ? "" : pm[2].startsWith('"') ? pm[2].slice(1, -1).replace(/\\(.)/g, "$1") : pm[2];
      // RFC 9421 2.3: Integers only; anything else is NaN and refused as malformed.
      if (k === "created" || k === "expires") params[k] = /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
      else if (k === "keyid" || k === "alg" || k === "nonce" || k === "tag") params[k] = v;
    }
    if (typeof params.created !== "number" || typeof params.keyid !== "string") continue;
    out[label] = { components, params, raw: `(${m[2].trim()})${m[3]}` };
  }
  return out;
}

export function parseSignature(value) {
  const out = {};
  for (const m of value.matchAll(/([A-Za-z0-9_*.-]+)=:([A-Za-z0-9+/=]+):/g)) out[m[1]] = fromBase64(m[2]);
  return out;
}

export function signatureBase(m, components, rawParams) {
  const lines = [];
  const seen = new Set();
  for (const c of components) {
    const key = c.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate component ${c}`);
    seen.add(key);
    let value;
    if (c.startsWith("@")) value = derived(c, m);
    else {
      const v = headerGet(m.headers, c);
      if (v === null) throw new Error(`missing header ${c}`);
      value = canonField(v);
    }
    lines.push(`${sfString(key)}: ${value}`);
  }
  lines.push(`"@signature-params": ${rawParams}`);
  return lines.join("\n");
}

export async function verifyContentDigest(header, body) {
  if (!header) return false;
  const m = /sha-256=:([A-Za-z0-9+/=]+):/.exec(header);
  if (!m) return false;
  const expect = toBase64(await sha256(typeof body === "string" ? utf8(body) : body));
  return m[1] === expect;
}

/**
 * Verify an RFC 9421 signature on a request or response message:
 * m = { kind: "request" | "response", method?, url?, status?, headers }.
 * opts: resolveKey(kid), required[] components, tag, now (unix seconds),
 * maxAgeSeconds, skewSeconds, label (verify that label only). The key is
 * judged at the signature's created (keyValidAtSigning).
 */
export async function verifyMessage(m, opts) {
  const si = headerGet(m.headers, "signature-input");
  const sg = headerGet(m.headers, "signature");
  if (!si || !sg) return { ok: false, reason: "no_signature" };
  const inputs = parseSignatureInput(si);
  const sigs = parseSignature(sg);
  let labels = Object.keys(inputs).filter((l) => sigs[l]);
  if (opts.label !== undefined) labels = labels.filter((l) => l === opts.label);
  if (labels.length === 0) return { ok: false, reason: "malformed" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let last = { ok: false, reason: "malformed" };
  for (const label of labels) {
    const { components, params, raw } = inputs[label];
    if (!Number.isInteger(params.created) || (params.expires !== undefined && !Number.isInteger(params.expires))) {
      last = { ok: false, reason: "malformed" };
      continue;
    }
    if (params.alg && params.alg !== "ed25519") {
      last = { ok: false, reason: "unsupported_alg" };
      continue;
    }
    if (opts.tag && params.tag !== opts.tag) {
      last = { ok: false, reason: "wrong_tag" };
      continue;
    }
    const lower = components.map((c) => c.toLowerCase());
    if (opts.required && opts.required.some((r) => !lower.includes(r.toLowerCase()))) {
      last = { ok: false, reason: "missing_component" };
      continue;
    }
    if (params.expires !== undefined && now >= params.expires) {
      last = { ok: false, reason: "expired" };
      continue;
    }
    if (params.created > now + (opts.skewSeconds ?? 60)) {
      last = { ok: false, reason: "not_yet_valid" };
      continue;
    }
    if (opts.maxAgeSeconds !== undefined && now - params.created > opts.maxAgeSeconds) {
      last = { ok: false, reason: "too_old" };
      continue;
    }
    const jwk = await opts.resolveKey(params.keyid);
    if (!jwk) {
      last = { ok: false, reason: "unknown_key" };
      continue;
    }
    const kv = keyValidAtSigning(jwk, params.created * 1000);
    if (!kv.ok) {
      last = { ok: false, reason: kv.reason };
      continue;
    }
    let base;
    try {
      base = signatureBase(m, components, raw);
    } catch {
      last = { ok: false, reason: "missing_component" };
      continue;
    }
    if (!(await ed25519Verify(jwk, sigs[label], utf8(base)))) {
      last = { ok: false, reason: "bad_signature" };
      continue;
    }
    return { ok: true, label, keyid: params.keyid, params, components, notes: kv.notes };
  }
  return last;
}

// ------------------------------------------------------------------ Semanto hashing

export async function pagesRoot(manifest) {
  const leaves = [];
  for (const p of manifest) leaves.push(await leafHash(digestBytes(p.hash)));
  return `sha256:${toHex(await rootFromLeafHashes(leaves))}`;
}

export async function factsRoot(facts) {
  const sorted = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const leaves = [];
  for (const f of sorted) leaves.push(await leafHash(utf8(canonicalize(f))));
  return `sha256:${toHex(await rootFromLeafHashes(leaves))}`;
}

export const tierHash = (value) => digest(canonicalize(value));
export const rootHash = (header) => digest(canonicalize(header));
export const versionId = (root) => semantoId("smv", root);

export async function factId(fact) {
  const { id: _id, ...rest } = fact;
  return semantoId("smf", await digest(canonicalize(rest)));
}

// ------------------------------------------------------------------ states

/**
 * The state of a version at `now`, in the words the ledger uses (src/ledger/revocation.ts):
 * current, superseded, behind (not yet valid), expired, withdrawn, or unsigned.
 * `version` is the Semanto file or its header; `revocations` is a signed
 * revocation list payload ({ revocations: [] }); `latest` is the newest version
 * number known, when the caller has it, so an older version reads as superseded.
 */
export function stateOf(version, now = new Date(), revocations = null, latest = null) {
  const header = version.header ?? version;
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  const root = version.root_hash ?? header.root_hash;
  const smv = root && isDigest(root) ? versionId(root) : null;
  const entries = revocations?.revocations ?? revocations?.entries ?? revocations?.payload?.revocations ?? [];
  for (const e of entries) {
    if (e.kind !== "version") continue;
    if ((smv && e.ref === smv) || (root && e.ref === root)) {
      if (!e.revoked_at || t >= Date.parse(e.revoked_at)) return "withdrawn";
    }
  }
  if (header.state === "withdrawn") return "withdrawn";
  if (header.state === "read" || header.state === "confirmed") return "unsigned";
  if (header.state === "signed" && version.header && !version.signature) return "unsigned";
  if (header.not_after && t >= Date.parse(header.not_after)) return "expired";
  if (header.not_before && t < Date.parse(header.not_before)) return "behind";
  if (typeof latest === "number" && Number.isInteger(header.version) && latest > header.version) return "superseded";
  return header.state === "signed" ? "current" : "unsigned";
}

// ------------------------------------------------------------------ top-level checks

class Checks {
  constructor() {
    this.list = [];
    this.notes = [];
  }
  add(name, ok, detail, reason) {
    this.list.push({ name, ok, detail });
    if (!ok && !this.reason) this.reason = reason ?? name;
    return ok;
  }
  note(text) {
    this.notes.push(text);
  }
  result(extra = {}) {
    const ok = this.list.every((c) => c.ok);
    return { ok, reason: ok ? null : this.reason, checks: this.list, notes: this.notes, ...extra };
  }
}

const atOf = (opts) => (opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date());

/**
 * Verify a whole Semanto file offline.
 *   file            the parsed Semanto JSON
 *   pageBytesByUrl  { url: Uint8Array | string } or a function (entry) => bytes | null; may be empty
 *   keys            { company, trooth } (any JWKS shape each); the company's signature
 *                   resolves only against `company`, the witness only against `trooth`.
 *                   A plain JWK Set is the company's, and then no witness can check out.
 *   opts.now        the instant to judge validity at (default: the real clock)
 *   opts.revocations an optional revocation list payload
 */
export async function verifySemanto(file, pageBytesByUrl = {}, keys = {}, opts = {}) {
  const c = new Checks();
  const at = atOf(opts);
  const companyKey = strictRoleResolver(keys, "company");
  const troothKey = strictRoleResolver(keys, "trooth");
  const h = file && file.header;
  if (!h || typeof h !== "object") {
    c.add("structure", false, "The file has no header.", "malformed");
    return c.result();
  }
  const issues = [];
  c.add("structure", validateStructure(file, issues), issues.length ? issues.map((i) => `${i.path}: ${i.message}`).join("; ") : "The file has every required field.", "malformed");
  if (!c.list[0].ok) return c.result({ issues });

  const root = await rootHash(h);
  c.add("root_hash", root === file.root_hash, root === file.root_hash ? `root_hash is the digest of the canonical header: ${root}` : `root_hash ${file.root_hash} is not the digest of the header, which is ${root}`, "root_hash_mismatch");
  const pr = await pagesRoot(h.pages_manifest);
  c.add("pages_root", pr === h.pages_root, pr === h.pages_root ? `pages_root matches the ${h.pages_manifest.length} page hashes in the manifest.` : `pages_root does not match the manifest (computed ${pr}).`, "pages_root_mismatch");
  const fr = await factsRoot(file.facts);
  c.add("facts_root", fr === h.facts_root, fr === h.facts_root ? `facts_root matches the ${file.facts.length} facts.` : `facts_root does not match the facts (computed ${fr}).`, "facts_root_mismatch");

  const tiers = { facts: file.facts, controls: file.controls, question_map: file.question_map, documents: file.documents, products: file.products, pages: h.pages_manifest };
  for (const t of h.tiers ?? []) {
    if (t.name === "header") continue;
    const v = tiers[t.name];
    if (v === undefined) {
      c.add(`tier.${t.name}`, false, `The header lists a ${t.name} tier that is not in the file.`, "tier_missing");
      continue;
    }
    const th = await tierHash(v);
    c.add(`tier.${t.name}`, th === t.hash, th === t.hash ? `The ${t.name} tier matches its hash.` : `The ${t.name} tier does not match its hash in the header.`, "tier_hash_mismatch");
  }

  let factIdsOk = true;
  const badFacts = [];
  for (const f of file.facts) {
    if ((await factId(f)) !== f.id) {
      factIdsOk = false;
      badFacts.push(f.id);
    }
  }
  c.add("fact_ids", factIdsOk, factIdsOk ? "Every fact id is the digest of its fact." : `These fact ids do not match their facts: ${badFacts.join(", ")}`, "fact_id_mismatch");

  // Page bytes, when given.
  let pagesChecked = 0;
  let pagesBad = [];
  for (const p of h.pages_manifest) {
    const b = typeof pageBytesByUrl === "function" ? await pageBytesByUrl(p) : (pageBytesByUrl[p.url] ?? pageBytesByUrl[p.id] ?? null);
    if (b === null || b === undefined) continue;
    pagesChecked++;
    const bytes = typeof b === "string" ? utf8(b) : b;
    if ((await digest(bytes)) !== p.hash) pagesBad.push(p.url);
  }
  if (pagesChecked > 0) c.add("page_bytes", pagesBad.length === 0, pagesBad.length === 0 ? `${pagesChecked} of ${h.pages_manifest.length} pages were given and every one matches its hash.` : `These pages do not match their hash: ${pagesBad.join(", ")}`, "page_hash_mismatch");
  else c.list.push({ name: "page_bytes", ok: true, detail: "No page bytes were given, so page bytes were not checked." });

  // The company's signature over the header, against the company's keys only.
  if (file.signature) {
    const v = await verifyJws(file.signature.jws, companyKey, { expectTyp: JWS_TYPES.semantoVersion, payload: h, at });
    c.add("company_signature", v.ok, v.ok ? `The header is signed by the company's key ${v.header.kid} (typ semanto-version).` : `The company's signature did not check out: ${v.reason}.`, v.ok ? undefined : v.reason);
    if (v.ok) v.notes.forEach((n) => c.note(`Company signature: ${n}.`));
  } else {
    c.add("company_signature", h.state !== "signed", h.state === "signed" ? "The file says it is signed but carries no signature." : "The file is not signed yet; that matches its state.", "unsigned");
  }

  // Trooth's witness statement, against Trooth's keys only.
  if (file.witness) {
    const payload = { root_hash: file.root_hash, witnessed_at: file.witness.at };
    const v = await verifyJws(file.witness.jws, troothKey, { expectTyp: JWS_TYPES.witness, payload, at });
    c.add("witness", v.ok, v.ok ? `Trooth witnessed root_hash at ${file.witness.at} with Trooth's key ${v.header.kid}.` : `The witness statement did not check out against Trooth's keys: ${v.reason}.`, v.ok ? undefined : `witness_${v.reason}`);
    if (v.ok) v.notes.forEach((n) => c.note(`Witness statement: ${n}.`));
  } else {
    c.list.push({ name: "witness", ok: true, detail: "No witness statement in the file." });
  }

  const state = stateOf(file, at, opts.revocations ?? null, opts.latest ?? null);
  c.add("state", state === "current" || h.state !== "signed", `State at ${at.toISOString()}: ${state}.`, state);
  return c.result({ issues, state, version_id: isDigest(file.root_hash) ? versionId(file.root_hash) : null });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validateStructure(file, out) {
  const push = (path, message) => out.push({ path, message });
  const h = file.header;
  if (h.schema !== "https://trooth.co/schemas/semanto/v1.json") push("header.schema", "unknown schema");
  if (h.contract !== 1) push("header.contract", "expected 1");
  if (typeof h.org !== "string" || !h.org) push("header.org", "required");
  if (!Array.isArray(h.domains) || h.domains.length === 0) push("header.domains", "at least one domain");
  if (!Number.isInteger(h.version) || h.version < 1) push("header.version", "positive integer");
  if (typeof h.built_at !== "string" || !ISO.test(h.built_at)) push("header.built_at", "ISO 8601 UTC");
  if (!["read", "confirmed", "signed", "withdrawn"].includes(h.state)) push("header.state", "unknown state");
  if (!isDigest(h.pages_root)) push("header.pages_root", "digest");
  if (!isDigest(h.facts_root)) push("header.facts_root", "digest");
  if (!Array.isArray(h.tiers)) push("header.tiers", "array");
  if (!Array.isArray(h.pages_manifest)) push("header.pages_manifest", "array");
  else h.pages_manifest.forEach((p, i) => {
    if (!isDigest(p.hash)) push(`header.pages_manifest[${i}].hash`, "digest");
    if (typeof p.url !== "string" || !/^https:\/\//.test(p.url)) push(`header.pages_manifest[${i}].url`, "https url");
  });
  if (!Array.isArray(file.facts)) push("facts", "array");
  else file.facts.forEach((f, i) => {
    if (!["witnessed", "public_record", "attested", "declared"].includes(f.provenance)) push(`facts[${i}].provenance`, "unknown provenance");
    if (!f.evidence || typeof f.evidence.url !== "string") push(`facts[${i}].evidence.url`, "required");
  });
  if (!file.controls || typeof file.controls.when_unknown !== "string") push("controls.when_unknown", "required");
  if (!isDigest(file.root_hash)) push("root_hash", "digest");
  return out.length === 0;
}

/**
 * Verify a per-page proof document (object "semanto.proof", what
 * /pages/{id}/proof returns) against the page's bytes, strictly. The version
 * header (opts.header, fetched beside the proof) and the company signature
 * are required. The witness statement and the log entry are required unless
 * opts.allowUnwitnessed or opts.allowUnlogged; when one is missing it is a
 * check named "witness" or "log" that reads "absent", never a silent skip.
 * Keys: { company, trooth }; the company signature resolves only against
 * `company`, the witness and the tree head only against `trooth`.
 */
export async function verifyPageProof(proof, pageBytes, keys = {}, opts = {}) {
  const c = new Checks();
  const at = atOf(opts);
  const companyKey = strictRoleResolver(keys, "company");
  const bytes = typeof pageBytes === "string" ? utf8(pageBytes) : pageBytes;
  const h = opts.header ?? proof.header ?? null;
  if (!proof || proof.object !== "semanto.proof" || !isDigest(proof.page_hash) || !isDigest(proof.pages_root) || !isDigest(proof.root_hash) || !proof.inclusion) {
    c.add("structure", false, "The proof is not a semanto.proof with full digests and an inclusion block.", "malformed");
    return c.result();
  }

  const pageDigest = await digest(bytes);
  c.add("page_hash", pageDigest === proof.page_hash, pageDigest === proof.page_hash ? `The page bytes hash to ${pageDigest}, the hash in the manifest.` : `The page bytes hash to ${pageDigest}; the proof says ${proof.page_hash}. The page is not the one that was signed.`, "page_hash_mismatch");

  const { index, size } = proof.inclusion;
  let inPages = false;
  try {
    inPages = await verifyInclusion(await leafHash(digestBytes(proof.page_hash)), index, size, (proof.inclusion.path ?? []).map(digestBytes), digestBytes(proof.pages_root));
  } catch {
    inPages = false;
  }
  c.add("pages_root", inPages, inPages ? `Page ${index + 1} of ${size} is in pages_root ${proof.pages_root}.` : "The inclusion proof does not lead to pages_root.", "pages_root_mismatch");

  if (h) {
    const entry = h.pages_manifest && h.pages_manifest[index];
    const root = await rootHash(h);
    const bound = h.pages_root === proof.pages_root && root === proof.root_hash && !!entry && entry.id === proof.page_id && entry.hash === proof.page_hash && h.version === proof.version;
    c.add("header", bound, bound ? `The version header hashes to root_hash ${root} and lists this page at index ${index}.` : root !== proof.root_hash ? `The header hashes to ${root}, not the proof's root_hash ${proof.root_hash}.` : "The header does not list this page at that index with this hash.", root !== proof.root_hash ? "root_hash_mismatch" : "manifest_mismatch");
    if (!proof.signature) c.add("company_signature", false, "The proof carries no company signature.", "signature_absent");
    else {
      const sig = await verifyJws(proof.signature, companyKey, { expectTyp: JWS_TYPES.semantoVersion, payload: h, at });
      c.add("company_signature", sig.ok, sig.ok ? `The header is signed by the company's key ${sig.header.kid} (typ semanto-version).` : `The company's signature did not check out: ${sig.reason}.`, sig.ok ? undefined : sig.reason);
      if (sig.ok) sig.notes.forEach((n) => c.note(`Company signature: ${n}.`));
    }
  } else {
    c.add("header", false, "No version header was given, so the proof is not tied to a signed version. Fetch the version beside the proof.", "header_absent");
    c.add("company_signature", false, "The company signature cannot be checked without the version header.", "header_absent");
  }

  await witnessAndLog(c, proof, keys, at, opts);
  return c.result({ version_id: proof.version_id ?? (isDigest(proof.root_hash) ? versionId(proof.root_hash) : null) });
}

/** The witness and log checks a page proof shares with the CLIs, strict unless allowed. */
async function witnessAndLog(c, proof, keys, at, opts) {
  const troothKey = strictRoleResolver(keys, "trooth");
  if (proof.witness && proof.witnessed_at) {
    const payload = { root_hash: proof.root_hash, witnessed_at: proof.witnessed_at };
    const w = await verifyJws(proof.witness, troothKey, { expectTyp: JWS_TYPES.witness, payload, at });
    c.add("witness", w.ok, w.ok ? `Trooth witnessed this root_hash at ${proof.witnessed_at} with Trooth's key ${w.header.kid}.` : `The witness statement did not check out against Trooth's keys: ${w.reason}.`, w.ok ? undefined : `witness_${w.reason}`);
    if (w.ok) w.notes.forEach((n) => c.note(`Witness statement: ${n}.`));
  } else {
    c.add("witness", !!opts.allowUnwitnessed, opts.allowUnwitnessed ? "Absent: the proof carries no witness statement (allowed by the caller)." : "Absent: the proof carries no witness statement.", "witness_absent");
  }

  if (proof.ledger) {
    const l = proof.ledger;
    let leafH = null;
    try {
      leafH = digestBytes(l.leaf_hash);
    } catch {
      leafH = null;
    }
    if (l.leaf) {
      const recomputed = toHex(await leafHash(utf8(canonicalize(l.leaf))));
      c.add("log_leaf", recomputed === String(l.leaf_hash).slice(7) && l.leaf.hash === proof.root_hash && l.leaf.kind === "semanto_version", recomputed === String(l.leaf_hash).slice(7) ? (l.leaf.hash === proof.root_hash ? "The log leaf is the canonical leaf record and names this root_hash." : "The log leaf names a different root_hash.") : "The leaf record does not hash to leaf_hash.", "log_leaf_mismatch");
    } else {
      c.list.push({ name: "log_leaf", ok: true, detail: "The proof carries only the leaf hash, so the leaf record was not recomputed." });
    }
    let inLog = false;
    try {
      inLog = leafH !== null && (await verifyInclusion(leafH, l.index, l.tree_size, (l.inclusion_path ?? l.path ?? []).map(digestBytes), digestBytes(l.root_hash)));
    } catch {
      inLog = false;
    }
    c.add("log_inclusion", inLog, inLog ? `Leaf ${l.index} is in the log of size ${l.tree_size} with root ${l.root_hash}.` : "The log inclusion proof does not lead to the tree head.", "log_inclusion_failed");
    const th = await verifyTreeHead({ jws: l.tree_head_jws ?? l.tree_head?.jws, payload: l.tree_head?.payload }, hasRoles(keys) ? keys : { trooth: [] }, { now: at });
    const same = th.ok && th.tree_size === l.tree_size && th.root_hash === l.root_hash;
    c.add("tree_head", same, th.ok ? (same ? `The tree head of size ${th.tree_size} is signed by Trooth (key ${th.kid}).` : "The signed tree head names a different tree.") : `The tree head signature did not check out against Trooth's keys: ${th.reason}.`, th.ok ? "tree_head_mismatch" : `tree_head_${th.reason}`);
  } else {
    c.add("log", !!opts.allowUnlogged, opts.allowUnlogged ? "Absent: the proof carries no log entry (allowed by the caller)." : "Absent: the proof carries no log entry.", "log_absent");
  }
}

/**
 * Verify a signed HTTP response: the RFC 9421 signature with tag
 * trooth-semanto over the Semanto components, and the RFC 9530 Content-Digest
 * against the body. The covered list is read from Signature-Input: the fixed
 * components must be covered, and Trooth-Signed-Page-Hash, Trooth-Signed-By,
 * Trooth-Semanto-State and Location must be covered whenever the response
 * carries them. Trooth-Page-Hash is always the digest of the body. A response
 * that says Trooth-Signed-By: witness resolves against Trooth's keys; any
 * other against the company's. opts.now may be a Date or unix seconds.
 */
export async function verifyResponse(status, headers, body, keys = {}, opts = {}) {
  const c = new Checks();
  const signedBy = (headerGet(headers, "trooth-signed-by") ?? "").trim().toLowerCase();
  const role = signedBy === "witness" ? "trooth" : "company";
  const resolve = roleResolver(keys, role);
  const nowSec = opts.now instanceof Date ? Math.floor(opts.now.getTime() / 1000) : typeof opts.now === "number" ? opts.now : opts.now ? Math.floor(Date.parse(opts.now) / 1000) : Math.floor(Date.now() / 1000);
  const bytes = typeof body === "string" ? utf8(body) : body;
  const digestOk = await verifyContentDigest(headerGet(headers, "content-digest"), bytes);
  c.add("content_digest", digestOk, digestOk ? "Content-Digest matches the body." : "Content-Digest does not match the body, or is missing.", "content_digest_mismatch");
  const v = await verifyMessage({ kind: "response", status, headers }, { resolveKey: resolve, required: opts.required ?? SEMANTO_RESPONSE_COMPONENTS, tag: opts.tag ?? SEMANTO_RESPONSE_TAG, now: nowSec, maxAgeSeconds: opts.maxAgeSeconds, skewSeconds: opts.skewSeconds });
  c.add("signature", v.ok, v.ok ? `The response is signed by the ${role === "trooth" ? "Trooth" : "company"} key ${v.keyid} with tag ${v.params.tag}, covering ${v.components.join(", ")}.` : `The response signature did not check out against the ${role === "trooth" ? "Trooth" : "company"} keys: ${v.reason}.`, v.ok ? undefined : v.reason);
  if (v.ok) {
    v.notes.forEach((n) => c.note(`Response signature: ${n}.`));
    const covered = v.components.map((x) => x.toLowerCase());
    const uncovered = SEMANTO_RESPONSE_MUST_COVER_WHEN_PRESENT.filter((name) => headerGet(headers, name) !== null && !covered.includes(name));
    c.add("covered_headers", uncovered.length === 0, uncovered.length === 0 ? "Every Trooth header the response carries is covered by the signature." : `These headers are present but not covered by the signature: ${uncovered.join(", ")}.`, "header_not_covered");
    for (const name of ["content-signal", "link"]) if (headerGet(headers, name) !== null && !covered.includes(name)) c.note(`${name} is present but not covered by the signature; do not rely on it.`);
  }
  const pageHash = headerGet(headers, "trooth-page-hash");
  const d = await digest(bytes);
  c.add("page_hash", pageHash === d, pageHash === d ? `Trooth-Page-Hash is the digest of the body: ${d}` : pageHash ? `Trooth-Page-Hash ${pageHash} is not the digest of the body (${d}).` : "The response carries no Trooth-Page-Hash.", "page_hash_mismatch");
  const signedPageHash = headerGet(headers, "trooth-signed-page-hash");
  return c.result({ keyid: v.ok ? v.keyid : null, params: v.ok ? v.params : null, signed_by: role, version: headerGet(headers, "trooth-semanto-version"), page_hash: pageHash, signed_page_hash: signedPageHash });
}

/** Verify a Web Bot Auth signed request against the agent's keys. Returns the Signature-Agent it names when it checks out. */
export async function verifyWebBotAuthRequest(method, url, headers, keys = {}, opts = {}) {
  const resolve = roleResolver(keys, "agent");
  const nowSec = opts.now instanceof Date ? Math.floor(opts.now.getTime() / 1000) : typeof opts.now === "number" ? opts.now : Math.floor(Date.now() / 1000);
  const inputs = parseSignatureInput(headerGet(headers, "signature-input") ?? "");
  const labels = Object.keys(inputs).filter((l) => inputs[l].params.tag === WEB_BOT_AUTH_TAG);
  if (labels.length > 1) return { ok: false, reason: "more_than_one_label" };
  const v = await verifyMessage({ kind: "request", method, url, headers }, { resolveKey: resolve, required: ["@authority", "signature-agent"], tag: WEB_BOT_AUTH_TAG, now: nowSec, maxAgeSeconds: opts.maxAgeSeconds, skewSeconds: opts.skewSeconds, ...(labels.length === 1 ? { label: labels[0] } : {}) });
  if (!v.ok) return v;
  const agentRaw = headerGet(headers, "signature-agent") ?? "";
  const agent = agentRaw.trim().replace(/^"|"$/g, "");
  return { ...v, agent };
}

/**
 * Verify a signed tree head against Trooth's keys: a compact JWS (typ
 * signed-tree-head) over { tree_size, root_hash, signed_at }. Accepts a
 * string, { jws }, or { payload, jws } (then the payload must match what was
 * signed).
 */
export async function verifyTreeHead(treeHead, keys = {}, opts = {}) {
  const resolve = roleResolver(keys, "trooth");
  const at = atOf(opts);
  const jws = typeof treeHead === "string" ? treeHead : treeHead?.jws ?? treeHead?.tree_head_jws;
  const given = typeof treeHead === "string" ? undefined : treeHead?.payload;
  const v = await verifyJws(jws, resolve, { expectTyp: JWS_TYPES.treeHead, payload: given, at });
  if (!v.ok) return v;
  const p = v.payload;
  if (typeof p !== "object" || p === null || !Number.isInteger(p.tree_size) || !isDigest(p.root_hash)) return { ok: false, reason: "malformed" };
  // A stored tree head ({ tree_size, root_hash, signed_at, jws }) must agree with what its JWS says.
  if (typeof treeHead === "object" && treeHead !== null && treeHead.root_hash !== undefined && (treeHead.root_hash !== p.root_hash || (treeHead.tree_size !== undefined && treeHead.tree_size !== p.tree_size))) return { ok: false, reason: "payload_mismatch" };
  return { ok: true, kid: v.header.kid, payload: p, tree_size: p.tree_size, root_hash: p.root_hash, signed_at: p.signed_at, notes: v.notes };
}

/** Verify an inclusion proof { leaf_hash | leaf, index, tree_size, path | inclusion_path, root_hash } against a log root. */
export async function verifyInclusionInLog(proof, rootHashOverride) {
  const leafH = proof.leaf_hash ? digestBytes(proof.leaf_hash) : await leafHash(utf8(canonicalize(proof.leaf)));
  const root = digestBytes(rootHashOverride ?? proof.root_hash);
  return verifyInclusion(leafH, proof.index, proof.tree_size, (proof.path ?? proof.inclusion_path ?? []).map(digestBytes), root);
}

/** Verify a consistency proof { from, to, old_root, new_root, path }. */
export async function verifyConsistency(proof) {
  return verifyConsistencyProof(proof.from, proof.to, digestBytes(proof.old_root), digestBytes(proof.new_root), (proof.path ?? []).map(digestBytes));
}

/**
 * Verify a checkpoint (signed note, golang.org/x/mod/sumdb/note):
 * "origin\nsize\nbase64root\n\n— name base64(keyhash4||sig)\n" where
 * keyhash4 = first 4 bytes of SHA-256(name || "\n" || 0x01 || pubkey). Only
 * Trooth's keys are tried, only a signature line named "trooth.co" counts,
 * and the origin must be "trooth.co/semanto/log/v1" unless the caller names
 * another log's origin.
 */
export async function verifyCheckpoint(text, keys = {}, expectedOrigin = TROOTH_LOG_ORIGIN, expectedName = TROOTH_LOG_SIGNER_NAME) {
  if (typeof text !== "string") return { ok: false, reason: "malformed" };
  const split = text.indexOf("\n\n");
  if (split < 0) return { ok: false, reason: "malformed" };
  const body = text.slice(0, split + 1);
  const sigBlock = text.slice(split + 2);
  const lines = body.split("\n");
  const origin = lines[0];
  const size = Number(lines[1]);
  if (expectedOrigin && origin !== expectedOrigin) return { ok: false, reason: "wrong_origin" };
  if (!/^\d+$/.test(lines[1] ?? "") || !Number.isInteger(size) || !lines[2]) return { ok: false, reason: "malformed" };
  let root;
  try {
    root = fromBase64(lines[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const candidates = roleKeys(keys, "trooth");
  let sawLine = false;
  let sawName = false;
  for (const line of sigBlock.split("\n")) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m) continue;
    sawLine = true;
    const name = m[1];
    if (expectedName && name !== expectedName) continue;
    sawName = true;
    let blob;
    try {
      blob = fromBase64(m[2]);
    } catch {
      continue;
    }
    const keyHash = blob.slice(0, 4);
    const sig = blob.slice(4);
    for (const jwk of candidates) {
      const pub = fromBase64Url(jwk.x);
      const expectHash = (await sha256(concat(utf8(name), new Uint8Array([0x0a, 0x01]), pub))).slice(0, 4);
      if (!bytesEqual(keyHash, expectHash)) continue;
      if (await ed25519Verify(jwk, sig, utf8(body))) return { ok: true, origin, name, tree_size: size, root_hash: `sha256:${toHex(root)}`, kid: jwk.kid };
      return { ok: false, reason: "bad_signature" };
    }
  }
  return { ok: false, reason: !sawLine ? "malformed" : !sawName ? "wrong_signer" : "unknown_key" };
}

/** Verify a signed offer (typ signed-offer) at `now` against the company's keys. */
export async function verifyOffer(jws, keys = {}, opts = {}) {
  const v = await verifyJws(jws, roleResolver(keys, "company"), { expectTyp: JWS_TYPES.offer, at: atOf(opts) });
  if (!v.ok) return v;
  return { ...v, offer_id: semantoId("smo", await digest(canonicalize(v.payload))) };
}

/** Verify a signed revocation list (typ revocation-list) against Trooth's keys and return its payload. */
export async function verifyRevocationList(jws, keys = {}, opts = {}) {
  const v = await verifyJws(jws, roleResolver(keys, "trooth"), { expectTyp: JWS_TYPES.revocation, at: atOf(opts) });
  if (!v.ok) return v;
  if (typeof v.payload !== "object" || v.payload === null || !Array.isArray(v.payload.revocations)) return { ok: false, reason: "malformed" };
  return v;
}

/** Parse a Link header into [{ url, params }]. */
export function parseLink(value) {
  const out = [];
  if (!value) return out;
  for (const m of value.matchAll(/<([^>]*)>((?:\s*;\s*[A-Za-z0-9-]+=(?:"[^"]*"|[^;,]*))*)/g)) {
    const params = {};
    for (const pm of m[2].matchAll(/;\s*([A-Za-z0-9-]+)=("([^"]*)"|[^;,]*)/g)) params[pm[1].toLowerCase()] = pm[3] !== undefined ? pm[3] : pm[2].trim();
    out.push({ url: m[1], params });
  }
  return out;
}
