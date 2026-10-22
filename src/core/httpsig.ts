// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// HTTP Message Signatures, RFC 9421, with Content-Digest, RFC 9530.
//
// Two uses:
//   1. Semanto SIGNS every response it serves (the markdown of a page, the
//      JSON-LD facts, the whole file), covering @status, content-type,
//      content-digest and the Trooth proof headers. Web Bot Auth signs the
//      agent's request with this same RFC; Semanto signs the answer. An agent
//      that already verifies Web Bot Auth directories can verify Semanto with
//      the same code and a key fetched from the domain's JWK Set.
//   2. Semanto VERIFIES Web Bot Auth requests (draft-ietf-webbotauth-httpsig-
//      protocol-00): tag="web-bot-auth", Signature-Agent covered, keys fetched
//      from the Signature-Agent URL. A valid signature names a key directory,
//      not an operator; receipts record exactly that and nothing more.
//
// Only Ed25519 ("ed25519" in the RFC 9421 algorithm registry) is produced or
// accepted. Structured Field serialization is the small subset these two uses
// need (an Inner List of String Items with Integer, String and Boolean
// parameters), written here so the module has no dependency.

import { toBase64, fromBase64, utf8 } from "./encoding";
import { sha256 } from "./hash";
import { importPrivate, importPublic, sign as rawSign, verify as rawVerify, type PrivateJwk, type PublicJwk } from "./keys";
import { keyValidAtSigning } from "./jws";

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export interface MessageForSigning {
  /** "request" or "response". */
  kind: "request" | "response";
  method?: string;
  url?: string;
  status?: number;
  headers: HeaderBag;
}

export interface SignatureParams {
  created: number;
  expires?: number;
  keyid: string;
  alg?: "ed25519";
  nonce?: string;
  tag?: string;
}

export interface SignedHeaders {
  "Signature-Input": string;
  Signature: string;
}

// ---------------------------------------------------------- field access

function getHeader(h: HeaderBag, name: string): string | null {
  const n = name.toLowerCase();
  if (typeof (h as Headers).get === "function") return (h as Headers).get(n);
  const rec = h as Record<string, string | string[] | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === n);
  if (!k) return null;
  const v = rec[k];
  if (v === undefined) return null;
  // RFC 9421 2.1: multiple field lines are combined with ", "
  return Array.isArray(v) ? v.map((x) => x.trim()).join(", ") : v;
}

// RFC 9421 2.1: strip leading and trailing whitespace, collapse obs-fold.
const canonField = (v: string): string => v.replace(/[\r\n]+[ \t]+/g, " ").trim();

// ---------------------------------------------------------- derived components

function derived(name: string, m: MessageForSigning): string {
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

// ---------------------------------------------------------- structured fields (subset)

function sfString(s: string): string {
  if (/[^\x20-\x7e]/.test(s)) throw new Error("sfString: non-ASCII");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeParams(p: SignatureParams): string {
  let out = "";
  out += `;created=${p.created}`;
  if (p.expires !== undefined) out += `;expires=${p.expires}`;
  out += `;keyid=${sfString(p.keyid)}`;
  if (p.alg) out += `;alg=${sfString(p.alg)}`;
  if (p.nonce) out += `;nonce=${sfString(p.nonce)}`;
  if (p.tag) out += `;tag=${sfString(p.tag)}`;
  return out;
}

export function serializeInnerList(components: string[], params: SignatureParams): string {
  return `(${components.map(sfString).join(" ")})${serializeParams(params)}`;
}

/** Parse `label=("a" "b");created=1;keyid="k"` entries of a Signature-Input field. */
export function parseSignatureInput(value: string): Record<string, { components: string[]; params: SignatureParams; raw: string }> {
  const out: Record<string, { components: string[]; params: SignatureParams; raw: string }> = {};
  const re = /([A-Za-z0-9_*.-]+)=\(((?:\s*"(?:[^"\\]|\\.)*")*)\s*\)((?:;[A-Za-z*][A-Za-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))?)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const label = m[1]!;
    const comps = [...m[2]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, "$1"));
    const params: Partial<SignatureParams> = {};
    for (const pm of m[3]!.matchAll(/;([A-Za-z*][A-Za-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|[^;,\s]+))?/g)) {
      const k = pm[1]!;
      const v = pm[2] === undefined ? "" : pm[2].startsWith('"') ? pm[2].slice(1, -1).replace(/\\(.)/g, "$1") : pm[2];
      // RFC 9421 2.3: created and expires are Integers. Anything else is kept as NaN so the verifier refuses it as malformed.
      if (k === "created" || k === "expires") (params as Record<string, unknown>)[k] = /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
      else if (k === "keyid" || k === "alg" || k === "nonce" || k === "tag") (params as Record<string, unknown>)[k] = v;
    }
    if (typeof params.created !== "number" || typeof params.keyid !== "string") continue;
    out[label] = { components: comps, params: params as SignatureParams, raw: `(${m[2]!.trim()})${m[3]!}` };
  }
  return out;
}

export function parseSignature(value: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const m of value.matchAll(/([A-Za-z0-9_*.-]+)=:([A-Za-z0-9+/=]+):/g)) out[m[1]!] = fromBase64(m[2]!);
  return out;
}

// ---------------------------------------------------------- signature base

export function signatureBase(m: MessageForSigning, components: string[], params: SignatureParams, rawParams?: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    const key = c.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate component ${c}`);
    seen.add(key);
    let value: string;
    if (c.startsWith("@")) value = derived(c, m);
    else {
      const v = getHeader(m.headers, c);
      if (v === null) throw new Error(`missing header ${c}`);
      value = canonField(v);
    }
    lines.push(`${sfString(key)}: ${value}`);
  }
  const sigParams = rawParams ?? serializeInnerList(components, params);
  lines.push(`"@signature-params": ${sigParams}`);
  return lines.join("\n");
}

// ---------------------------------------------------------- Content-Digest (RFC 9530)

export async function contentDigest(body: Uint8Array | string): Promise<string> {
  return `sha-256=:${toBase64(await sha256(typeof body === "string" ? utf8(body) : body))}:`;
}

export async function verifyContentDigest(header: string | null, body: Uint8Array | string): Promise<boolean> {
  if (!header) return false;
  const m = /sha-256=:([A-Za-z0-9+/=]+):/.exec(header);
  if (!m) return false;
  const expect = toBase64(await sha256(typeof body === "string" ? utf8(body) : body));
  return m[1] === expect;
}

// ---------------------------------------------------------- sign and verify

export interface SignOptions {
  label?: string;
  components: string[];
  created?: number;
  /** Seconds of validity; expires = created + ttl. */
  ttlSeconds?: number;
  tag?: string;
  nonce?: string;
}

export async function signMessage(m: MessageForSigning, priv: PrivateJwk, opts: SignOptions): Promise<SignedHeaders> {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const params: SignatureParams = {
    created,
    ...(opts.ttlSeconds ? { expires: created + opts.ttlSeconds } : {}),
    keyid: priv.kid,
    alg: "ed25519",
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
  };
  const base = signatureBase(m, opts.components, params);
  const sig = await rawSign(await importPrivate(priv), utf8(base));
  const label = opts.label ?? "sig1";
  return {
    "Signature-Input": `${label}=${serializeInnerList(opts.components, params)}`,
    Signature: `${label}=:${toBase64(sig)}:`,
  };
}

export type SigVerification =
  | { ok: true; label: string; keyid: string; params: SignatureParams; components: string[]; notes: string[] }
  | { ok: false; reason: "no_signature" | "malformed" | "unknown_key" | "bad_signature" | "expired" | "not_yet_valid" | "missing_component" | "wrong_tag" | "unsupported_alg" | "too_old" | "key_not_yet_valid" | "key_expired" | "key_revoked" };

export interface VerifyOptions {
  resolveKey: (keyid: string) => Promise<PublicJwk | null> | PublicJwk | null;
  /** Components that MUST be covered. */
  required?: string[];
  /** The tag that MUST be present (Web Bot Auth: "web-bot-auth"). */
  tag?: string;
  now?: number;
  /** Reject a `created` older than this many seconds (replay window). */
  maxAgeSeconds?: number;
  /** Accept `created` this far in the future (clock skew). */
  skewSeconds?: number;
  /**
   * Verify this label only. Without it every label is tried in turn, which
   * is right for a response but wrong for a request whose nonce is claimed
   * afterwards: the caller must choose one label, verify it, and claim that
   * label's nonce (a decoy label cannot then lend its fresh nonce to a
   * replayed signature).
   */
  label?: string;
  /**
   * Read the signature from these fields instead of Signature-Input and
   * Signature. A proxy that vouches for a request whose Signature fields hold
   * someone else's signature carries its own in separate fields, so its
   * signature can cover the original Signature fields whole (the connector
   * forwarding signature, src/readers/forwarded.ts).
   */
  inputHeader?: string;
  signatureHeader?: string;
}

export async function verifyMessage(m: MessageForSigning, opts: VerifyOptions): Promise<SigVerification> {
  const si = getHeader(m.headers, opts.inputHeader ?? "signature-input");
  const sg = getHeader(m.headers, opts.signatureHeader ?? "signature");
  if (!si || !sg) return { ok: false, reason: "no_signature" };
  const inputs = parseSignatureInput(si);
  const sigs = parseSignature(sg);
  let labels = Object.keys(inputs).filter((l) => sigs[l]);
  if (opts.label !== undefined) labels = labels.filter((l) => l === opts.label);
  if (labels.length === 0) return { ok: false, reason: "malformed" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let last: SigVerification = { ok: false, reason: "malformed" };
  for (const label of labels) {
    const { components, params, raw } = inputs[label]!;
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
    if (opts.required?.some((r) => !lower.includes(r.toLowerCase()))) {
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
    let base: string;
    try {
      base = signatureBase(m, components, params, raw);
    } catch {
      last = { ok: false, reason: "missing_component" };
      continue;
    }
    const good = await rawVerify(await importPublic(jwk), sigs[label]!, utf8(base));
    if (!good) {
      last = { ok: false, reason: "bad_signature" };
      continue;
    }
    // The key is judged when the message was signed (created), as a JWS key is judged at its iat.
    const kv = keyValidAtSigning(jwk, params.created * 1000);
    if (!kv.ok) {
      last = { ok: false, reason: kv.reason };
      continue;
    }
    return { ok: true, label, keyid: params.keyid, params, components, notes: kv.notes };
  }
  return last;
}

/**
 * The components Semanto covers on every response it signs. Trooth-Page-Hash
 * is always the digest of the exact body bytes of this response
 * (docs/spec/response-signatures.md).
 */
export const SEMANTO_RESPONSE_COMPONENTS = ["@status", "content-type", "content-digest", "trooth-semanto-version", "trooth-page-hash"] as const;

/**
 * Headers Semanto covers whenever it sends them. Trooth-Signed-Page-Hash
 * carries the manifest hash of the signed page when the body is a derived
 * representation (a page's JSON-LD, a page behind its live copy, a proof
 * object). A verifier reads the covered list from Signature-Input and refuses
 * a Trooth header that is present but not covered.
 */
export const SEMANTO_RESPONSE_OPTIONAL_COMPONENTS = ["trooth-signed-page-hash", "trooth-signed-by", "trooth-semanto-state", "location", "content-signal", "link"] as const;

/** The optional headers a verifier must find covered when they are present; content-signal and link are reported, not required. */
export const SEMANTO_RESPONSE_MUST_COVER_WHEN_PRESENT = ["trooth-signed-page-hash", "trooth-signed-by", "trooth-semanto-state", "location"] as const;

/** The component list for one response: the fixed list plus every optional header the response carries. */
export function semantoResponseComponents(headers: HeaderBag): string[] {
  return [...SEMANTO_RESPONSE_COMPONENTS, ...SEMANTO_RESPONSE_OPTIONAL_COMPONENTS.filter((c) => getHeader(headers, c) !== null)];
}

/** The components Web Bot Auth requires on a signed request (draft-ietf-webbotauth-httpsig-protocol-00). */
export const WEB_BOT_AUTH_REQUIRED = ["@authority", "signature-agent"] as const;
