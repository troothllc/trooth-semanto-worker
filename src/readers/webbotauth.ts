// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Web Bot Auth verification, draft-ietf-webbotauth-httpsig-protocol-00 (with
// draft-ietf-webbotauth-architecture and the key directory format of
// draft-ietf-webbotauth-httpsig-protocol Appendix B). An agent signs its
// request with RFC 9421: tag "web-bot-auth", @authority and signature-agent
// covered, created and expires present, a nonce. Signature-Agent is a
// Structured Field String (RFC 9651) holding an https URL. Keys are a JWK Set
// at that origin's /.well-known/http-message-signatures-directory, served as
// application/http-message-signatures-directory+json, optionally signed by
// each of its own keys over @authority and content-digest (Appendix B.1).
//
// What a pass means: the request was signed by a key published at that URL.
// It names a key directory, not an operator and not a product. The result
// carries the directory URL and the keyid and nothing else. User-Agent is
// never read here and never proves anything.

import { parseSignatureInput, verifyContentDigest, verifyMessage, WEB_BOT_AUTH_REQUIRED, type HeaderBag } from "@/core/httpsig";
import { thumbprint, keyValidAt, type Jwks, type PublicJwk } from "@/core/keys";
import type { CachedDirectory, HttpPort, KeyCache, NonceStore } from "./ports";

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const DIRECTORY_TAG = "http-message-signatures-directory";
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_MEDIA = "application/http-message-signatures-directory+json";
/** A signature older than this is a replay candidate and is refused. */
export const REPLAY_WINDOW_SECONDS = 300;
export const CLOCK_SKEW_SECONDS = 60;
export const DEFAULT_DIRECTORY_TTL_SECONDS = 3600;

export type WebBotAuthResult =
  | { proven: true; agent_key_url: string; keyid: string; directory_signed: boolean }
  | {
      proven: false;
      reason:
        | "no_signature"
        | "no_signature_agent"
        | "signature_agent_not_https"
        | "missing_tag"
        | "missing_component"
        | "missing_created_or_expires"
        | "expires_too_far"
        | "missing_nonce"
        | "expired"
        | "not_yet_valid"
        | "too_old"
        | "replayed_nonce"
        | "directory_unreachable"
        | "directory_malformed"
        | "directory_signature_failed"
        | "unknown_key"
        | "key_not_valid_now"
        | "bad_signature"
        | "unsupported_alg"
        | "malformed";
      /** A plain sentence for a log line. */
      sentence: string;
    };

export interface IncomingRequest {
  method: string;
  url: string;
  headers: HeaderBag;
}

export interface WebBotAuthDeps {
  http: HttpPort;
  cache: KeyCache;
  nonces: NonceStore;
  /** Unix seconds. */
  now?: () => number;
}

// ---------------------------------------------------------------- Signature-Agent

/** Parse an RFC 9651 sf-string holding an https URL. A bare token is accepted for robustness, but it must still be https. */
export function parseSignatureAgent(value: string | null): { ok: true; url: string } | { ok: false; reason: "no_signature_agent" | "signature_agent_not_https" } {
  if (value === null || value.trim() === "") return { ok: false, reason: "no_signature_agent" };
  const v = value.trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  const raw = m ? m[1]!.replace(/\\(.)/g, "$1") : v;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "signature_agent_not_https" };
  }
  if (u.protocol !== "https:" || u.username || u.password) return { ok: false, reason: "signature_agent_not_https" };
  return { ok: true, url: u.href };
}

/** The directory URL for a Signature-Agent: the well-known path on its origin, unless a specific path was given. */
export function directoryUrl(agentUrl: string): string {
  const u = new URL(agentUrl);
  if (u.pathname === "/" || u.pathname === "") return `${u.origin}${DIRECTORY_PATH}`;
  return u.href;
}

// ---------------------------------------------------------------- known directories (by URL only)

/**
 * Display names for directories whose operators have published them. Keyed by
 * the Signature-Agent origin and nothing else. A name is shown only after the
 * signature proves the key came from that URL; a User-Agent string never maps
 * here. Each entry must be checked against the operator's own documentation
 * before launch (a founder step in the report).
 */
export const KNOWN_DIRECTORIES: Record<string, string> = {
  "https://chatgpt.com": "ChatGPT agent (OpenAI)",
};

export function directoryDisplayName(agentKeyUrl: string | null, proof: "web_bot_auth" | "none", known: Record<string, string> = KNOWN_DIRECTORIES): string {
  if (proof !== "web_bot_auth" || !agentKeyUrl) return "unproven reader";
  let origin: string;
  try {
    origin = new URL(agentKeyUrl).origin;
  } catch {
    return "unproven reader";
  }
  return known[origin] ?? origin.replace(/^https:\/\//, "");
}

// ---------------------------------------------------------------- directory fetch and check

export interface Directory {
  url: string;
  keys: PublicJwk[];
  /** True when the directory carried its own signature and that signature checked out. */
  signed: boolean;
}

export type DirectoryFetch = { ok: true; directory: Directory } | { ok: false; reason: "directory_unreachable" | "directory_malformed" | "directory_signature_failed"; sentence: string };

function parseMaxAge(cacheControl: string | undefined): number | null {
  if (!cacheControl) return null;
  const m = /max-age=(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) : null;
}

export async function fetchDirectory(agentUrl: string, deps: WebBotAuthDeps): Promise<DirectoryFetch> {
  const url = directoryUrl(agentUrl);
  const nowMs = (deps.now ? deps.now() : Math.floor(Date.now() / 1000)) * 1000;
  let cached = await deps.cache.get(url);
  if (!cached || cached.expires_at <= nowMs) {
    let res: Awaited<ReturnType<HttpPort["get"]>>;
    try {
      res = await deps.http.get(url, { accept: DIRECTORY_MEDIA });
    } catch (e) {
      return { ok: false, reason: "directory_unreachable", sentence: `The key directory at ${url} could not be fetched: ${(e as Error).message}` };
    }
    if (res.status !== 200) return { ok: false, reason: "directory_unreachable", sentence: `The key directory at ${url} answered HTTP ${res.status}.` };
    const ttl = parseMaxAge(res.headers["cache-control"]) ?? DEFAULT_DIRECTORY_TTL_SECONDS;
    cached = { body: res.body, headers: res.headers, fetched_at: new Date(nowMs).toISOString(), expires_at: nowMs + ttl * 1000 } satisfies CachedDirectory;
    await deps.cache.put(url, cached);
  }
  return parseAndCheckDirectory(url, cached, Math.floor(nowMs / 1000));
}

/** Parse a JWK Set; refuse a key whose kid is not its RFC 7638 thumbprint; check the directory's own signature when present. */
export async function parseAndCheckDirectory(url: string, cached: CachedDirectory, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<DirectoryFetch> {
  let parsed: Partial<Jwks>;
  try {
    parsed = JSON.parse(cached.body) as Partial<Jwks>;
  } catch {
    return { ok: false, reason: "directory_malformed", sentence: `The key directory at ${url} is not JSON.` };
  }
  if (!Array.isArray(parsed.keys)) return { ok: false, reason: "directory_malformed", sentence: `The key directory at ${url} has no keys array.` };
  const keys: PublicJwk[] = [];
  for (const k of parsed.keys as Partial<PublicJwk>[]) {
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
    const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x: k.x });
    if (typeof k.kid === "string" && k.kid !== kid) continue;
    keys.push({ kty: "OKP", crv: "Ed25519", x: k.x, kid, alg: "EdDSA", use: "sig", ...(k.nbf ? { nbf: k.nbf } : {}), ...(k.exp ? { exp: k.exp } : {}), ...(k.revoked_at ? { revoked_at: k.revoked_at } : {}) });
  }
  if (keys.length === 0) return { ok: false, reason: "directory_malformed", sentence: `The key directory at ${url} has no usable Ed25519 key.` };
  const h = cached.headers;
  const sigInput = h["signature-input"];
  const sig = h["signature"];
  if (!sigInput || !sig) return { ok: true, directory: { url, keys, signed: false } };
  // Appendix B.1: one signature per key, tag "http-message-signatures-directory", over @authority and content-digest, keyid is the key's thumbprint.
  if (!(await verifyContentDigest(h["content-digest"] ?? null, cached.body))) return { ok: false, reason: "directory_signature_failed", sentence: `The key directory at ${url} is signed but its Content-Digest does not match the body.` };
  const inputs = parseSignatureInput(sigInput);
  const labels = Object.keys(inputs);
  if (labels.length === 0) return { ok: false, reason: "directory_signature_failed", sentence: `The key directory at ${url} has a Signature header that cannot be parsed.` };
  let checkedAny = false;
  for (const label of labels) {
    const { params } = inputs[label]!;
    const key = keys.find((k) => k.kid === params.keyid);
    if (!key) return { ok: false, reason: "directory_signature_failed", sentence: `The key directory at ${url} is signed by a key it does not publish.` };
    const singleInput = `${label}=${inputs[label]!.raw}`;
    const singleSig = new RegExp(`(?:^|,\\s*)${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=:([A-Za-z0-9+/=]+):`).exec(sig);
    if (!singleSig) return { ok: false, reason: "directory_signature_failed", sentence: `The key directory at ${url} has no signature for label ${label}.` };
    const v = await verifyMessage(
      { kind: "response", status: 200, url, headers: { "content-digest": h["content-digest"]!, "signature-input": singleInput, signature: `${label}=:${singleSig[1]}:` } },
      { resolveKey: () => key, required: ["@authority", "content-digest"], tag: DIRECTORY_TAG, now: nowSeconds },
    );
    if (!v.ok) return { ok: false, reason: "directory_signature_failed", sentence: `The key directory at ${url} is signed but the signature by ${params.keyid} did not verify (${v.reason}).` };
    checkedAny = true;
  }
  return { ok: true, directory: { url, keys, signed: checkedAny } };
}

// ---------------------------------------------------------------- the request check

const SENTENCES: Record<Exclude<WebBotAuthResult, { proven: true }>["reason"], string> = {
  no_signature: "The request carries no Signature-Input and Signature headers.",
  no_signature_agent: "The request carries no Signature-Agent header.",
  signature_agent_not_https: "Signature-Agent is not an https URL in a structured-field string.",
  missing_tag: 'The signature does not carry tag="web-bot-auth".',
  missing_component: "The signature does not cover @authority and signature-agent.",
  missing_created_or_expires: "The signature does not carry both created and expires.",
  expires_too_far: "The signature's expires is more than five minutes after created.",
  missing_nonce: "The signature carries no nonce, so a replay cannot be told from the original.",
  expired: "The signature has expired.",
  not_yet_valid: "The signature's created is in the future beyond the allowed skew.",
  too_old: "The signature was created more than five minutes ago.",
  replayed_nonce: "This nonce was already seen inside the replay window.",
  directory_unreachable: "The key directory could not be fetched.",
  directory_malformed: "The key directory is not a usable JWK Set.",
  directory_signature_failed: "The key directory is signed and the signature did not verify.",
  unknown_key: "The keyid is not in the key directory.",
  key_not_valid_now: "The key is outside its validity window.",
  bad_signature: "The signature did not verify.",
  unsupported_alg: "Only ed25519 signatures are accepted.",
  malformed: "The signature headers could not be parsed.",
};

function fail(reason: Exclude<WebBotAuthResult, { proven: true }>["reason"], extra?: string): WebBotAuthResult {
  return { proven: false, reason, sentence: extra ? `${SENTENCES[reason]} ${extra}` : SENTENCES[reason] };
}

function header(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const rec = h as Record<string, string | string[] | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? rec[k] : undefined;
  return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Verify one request. The order: the Signature-Agent URL, then the signature
 * parameters (tag, components, created, expires, nonce), then the key
 * directory, then the signature itself, and only then the nonce is claimed so
 * an unsigned flood cannot fill the nonce store.
 */
export async function verifyWebBotAuth(req: IncomingRequest, deps: WebBotAuthDeps): Promise<WebBotAuthResult> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const si = header(req.headers, "signature-input");
  const sg = header(req.headers, "signature");
  if (!si || !sg) return fail("no_signature");
  const agent = parseSignatureAgent(header(req.headers, "signature-agent"));
  if (!agent.ok) return fail(agent.reason);

  const inputs = parseSignatureInput(si);
  const labels = Object.keys(inputs);
  if (labels.length === 0) return fail("malformed");
  // Pick the web-bot-auth labelled signature; any label name is allowed by the draft.
  const candidates = labels.filter((l) => inputs[l]!.params.tag === WEB_BOT_AUTH_TAG);
  if (candidates.length === 0) return fail("missing_tag");
  const label = candidates[0]!;
  const { params, components } = inputs[label]!;
  const lower = components.map((c) => c.toLowerCase());
  if (WEB_BOT_AUTH_REQUIRED.some((r) => !lower.includes(r))) return fail("missing_component");
  if (typeof params.created !== "number" || typeof params.expires !== "number" || !Number.isFinite(params.created) || !Number.isFinite(params.expires)) return fail("missing_created_or_expires");
  if (params.expires - params.created > REPLAY_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) return fail("expires_too_far");
  if (!params.nonce) return fail("missing_nonce");
  if (now >= params.expires) return fail("expired");
  if (params.created > now + CLOCK_SKEW_SECONDS) return fail("not_yet_valid");
  if (now - params.created > REPLAY_WINDOW_SECONDS) return fail("too_old");

  const dir = await fetchDirectory(agent.url, deps);
  if (!dir.ok) return { proven: false, reason: dir.reason, sentence: dir.sentence };
  const key = dir.directory.keys.find((k) => k.kid === params.keyid);
  if (!key) return fail("unknown_key");
  const kv = keyValidAt(key, new Date(params.created * 1000));
  if (!kv.ok) return fail("key_not_valid_now");

  const v = await verifyMessage(
    { kind: "request", method: req.method, url: req.url, headers: req.headers },
    { resolveKey: (kid) => (kid === key.kid ? key : null), required: [...WEB_BOT_AUTH_REQUIRED], tag: WEB_BOT_AUTH_TAG, now, maxAgeSeconds: REPLAY_WINDOW_SECONDS, skewSeconds: CLOCK_SKEW_SECONDS },
  );
  if (!v.ok) {
    const r = v.reason;
    if (r === "wrong_tag") return fail("missing_tag");
    if (r === "no_signature") return fail("no_signature");
    return fail(r);
  }
  const fresh = await deps.nonces.claim(`${key.kid}:${params.nonce}`, params.expires * 1000, now * 1000);
  if (!fresh) return fail("replayed_nonce");
  return { proven: true, agent_key_url: agent.url, keyid: key.kid, directory_signed: dir.directory.signed };
}

/** What a receipt records from a result. A failure records nothing about the agent. */
export function proofFromResult(r: WebBotAuthResult): { proof: "web_bot_auth" | "none"; agent_key_url: string | null; keyid: string | null } {
  return r.proven ? { proof: "web_bot_auth", agent_key_url: r.agent_key_url, keyid: r.keyid } : { proof: "none", agent_key_url: null, keyid: null };
}
