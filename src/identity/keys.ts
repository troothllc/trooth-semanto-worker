// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Key discovery and custody for a company's signing key.
//
//   hosted key      Trooth generates an Ed25519 key for the company and keeps
//                   the private half in the Worker's secret store. The public
//                   half is published in the JWKS and named in DNS.
//   customer key    The company keeps the private key. Trooth accepts the
//                   public JWK only, prepares the exact bytes to sign (the JWS
//                   signing input) and assembles the JWS from the returned
//                   signature. The private key never reaches Trooth.
//
// Discovery follows what Web Bot Auth agents already do for their own keys:
// a JWK Set (RFC 7517) at a well-known HTTPS URL, Ed25519 keys as RFC 8037
// JWKs with RFC 7638 thumbprints as kids. Binding to the domain is proven two
// ways: the JWKS is served on the domain itself at
// /.well-known/trooth-keys.json (RFC 8615 well-known URIs), and a DNS TXT
// record at _trooth-keys.<domain> names the current kid, the pattern of
// DKIM (RFC 6376) and BIMI selectors. Rotation keeps both keys in the set for
// 30 days so nothing already signed goes dark (the overlap practice of DKIM
// key rotation guidance, M3AAWG 2019).

import { toBase64Url, utf8 } from "@/core/encoding";
import { canonicalize } from "@/core/canonical";
import { JWS_TYPES, verifyJws, type JwsHeader } from "@/core/jws";
import { dnsKeyRecord, findKey, generateKeyPair, keyValidAt, parseDnsKeyRecords, thumbprint, toPublic, type Jwks, type PrivateJwk, type PublicJwk } from "@/core/keys";
import type { SemantoHeader } from "@/core/semanto";
import type { DnsPort, HttpPort } from "./ports";

export type Custody = "hosted" | "customer";

export const ROTATION_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;
/** Expired keys stay published this long so old signatures can still be checked against a dated key. */
export const RETAIN_EXPIRED_MS = 365 * 24 * 60 * 60 * 1000;

export interface KeyRecord {
  kid: string;
  trooth_id: string;
  custody: Custody;
  public_jwk: PublicJwk;
  created_at: string;
}

/** A new hosted key, valid from now. The private half is returned once, to be stored as a secret, and never printed. */
export async function createHostedKey(troothId: string, now: Date = new Date()): Promise<{ record: KeyRecord; privateJwk: PrivateJwk }> {
  const { publicJwk, privateJwk } = await generateKeyPair();
  const pub: PublicJwk = { ...publicJwk, nbf: now.toISOString() };
  return { record: { kid: pub.kid, trooth_id: troothId, custody: "hosted", public_jwk: pub, created_at: now.toISOString() }, privateJwk: { ...privateJwk, nbf: pub.nbf } };
}

// ---------------------------------------------------------------- the JWKS document

export const jwksPath = "/.well-known/trooth-keys.json";
export const jwksUrl = (domain: string): string => `https://${domain.toLowerCase()}${jwksPath}`;
export const dnsName = (domain: string): string => `_trooth-keys.${domain.toLowerCase()}`;
export { dnsKeyRecord };

/**
 * The JWK Set a company publishes. Every key keeps its nbf, exp and
 * revoked_at so a verifier applies keyValidAt at the signature's time, not
 * at reading time. Keys expired for more than RETAIN_EXPIRED_MS are dropped.
 */
export function buildJwks(keys: PublicJwk[], now: Date = new Date()): Jwks {
  const t = now.getTime();
  const kept = keys.filter((k) => !(k.exp && t - Date.parse(k.exp) > RETAIN_EXPIRED_MS));
  const ordered = [...kept].sort((a, b) => {
    const av = keyValidAt(a, now).ok ? 0 : 1;
    const bv = keyValidAt(b, now).ok ? 0 : 1;
    if (av !== bv) return av - bv;
    return (b.nbf ?? "") < (a.nbf ?? "") ? -1 : (b.nbf ?? "") > (a.nbf ?? "") ? 1 : 0;
  });
  return { keys: ordered.map(stripPrivate) };
}

function stripPrivate(k: PublicJwk): PublicJwk {
  const { kty, crv, x, kid, alg, use, nbf, exp, revoked_at } = k as PublicJwk & { d?: string };
  return { kty, crv, x, kid, alg, use, ...(nbf ? { nbf } : {}), ...(exp ? { exp } : {}), ...(revoked_at ? { revoked_at } : {}) };
}

/** The key that signs now: valid at `now`, the newest nbf wins. */
export function currentKey(keys: PublicJwk[], now: Date = new Date()): PublicJwk | null {
  const valid = keys.filter((k) => keyValidAt(k, now).ok);
  if (valid.length === 0) return null;
  // Newest nbf first; on a tie, the key that is not retiring (no exp) wins.
  return valid.sort((a, b) => ((b.nbf ?? "") < (a.nbf ?? "") ? -1 : (b.nbf ?? "") > (a.nbf ?? "") ? 1 : (a.exp ? 1 : 0) - (b.exp ? 1 : 0)))[0]!;
}

// ---------------------------------------------------------------- rotation

export interface Rotation {
  /** The new key: nbf now. */
  next: { record: KeyRecord; privateJwk: PrivateJwk };
  /** The old key with exp set 30 days out. It stays in the JWKS through the overlap. */
  retired: PublicJwk;
  /** The DNS record to publish for the new kid. */
  dns_record: string;
  overlap_until: string;
}

export async function rotateHostedKey(troothId: string, current: PublicJwk, now: Date = new Date()): Promise<Rotation> {
  const next = await createHostedKey(troothId, now);
  const overlap_until = new Date(now.getTime() + ROTATION_OVERLAP_MS).toISOString();
  const retired: PublicJwk = { ...stripPrivate(current), exp: current.exp && Date.parse(current.exp) < Date.parse(overlap_until) ? current.exp : overlap_until };
  return { next, retired, dns_record: dnsKeyRecord(next.record.kid), overlap_until };
}

/** Withdraw a key now. A signature dated after revoked_at is not valid; earlier ones stand. */
export function revokeKey(key: PublicJwk, at: Date = new Date()): PublicJwk {
  return { ...stripPrivate(key), revoked_at: at.toISOString() };
}

// ---------------------------------------------------------------- binding status

export type BindingLevel = "domain_and_dns" | "domain_only" | "trooth_hosted_only";

export interface BindingStatus {
  domain: string;
  kid: string;
  jwks_url: string;
  /** The JWKS answered 200 with JSON on the company's own domain. */
  jwks_served: boolean;
  /** That JWKS lists the current kid. */
  jwks_has_kid: boolean;
  dns_name: string;
  /** Any v=trooth1 record is present. */
  dns_record_present: boolean;
  /** The DNS record names the current kid. */
  dns_names_kid: boolean;
  level: BindingLevel;
  /** Plain words. */
  sentence: string;
  checked_at: string;
}

export async function bindingStatus(domain: string, kid: string, http: HttpPort, dns: DnsPort, now: Date = new Date()): Promise<BindingStatus> {
  const url = jwksUrl(domain);
  let jwks_served = false;
  let jwks_has_kid = false;
  try {
    const res = await http.get(url, { accept: "application/json" });
    if (res.status === 200) {
      const parsed = JSON.parse(res.body) as Partial<Jwks>;
      if (Array.isArray(parsed.keys)) {
        jwks_served = true;
        jwks_has_kid = findKey({ keys: parsed.keys }, kid) !== null;
      }
    }
  } catch {
    jwks_served = false;
  }
  const name = dnsName(domain);
  let txt: string[] = [];
  try {
    txt = await dns.txt(name);
  } catch {
    txt = [];
  }
  const kids = parseDnsKeyRecords(txt);
  const dns_record_present = kids.length > 0;
  const dns_names_kid = kids.includes(kid);
  const onDomain = jwks_served && jwks_has_kid;
  const level: BindingLevel = onDomain && dns_names_kid ? "domain_and_dns" : onDomain ? "domain_only" : "trooth_hosted_only";
  const sentence =
    level === "domain_and_dns"
      ? `${domain} publishes this key at ${jwksPath} and names it in DNS.`
      : level === "domain_only"
        ? `${domain} publishes this key at ${jwksPath}. The DNS record at ${name} does not name it yet.`
        : `${domain} does not publish this key itself yet. Trooth serves it from its own host.`;
  return { domain, kid, jwks_url: url, jwks_served, jwks_has_kid, dns_name: name, dns_record_present, dns_names_kid, level, sentence, checked_at: now.toISOString() };
}

// ---------------------------------------------------------------- customer-held keys

export type PublicKeyAcceptance = { ok: true; jwk: PublicJwk } | { ok: false; reason: string };

/** Accept a public JWK from the company. A private member ("d") is refused outright and never stored. */
export async function acceptCustomerPublicKey(input: unknown, now: Date = new Date()): Promise<PublicKeyAcceptance> {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "The key must be a JSON Web Key object." };
  const j = input as Record<string, unknown>;
  if ("d" in j) return { ok: false, reason: "This is a private key. Keep it. Send only the public key (no \"d\" member)." };
  if (j.kty !== "OKP" || j.crv !== "Ed25519") return { ok: false, reason: "Only Ed25519 keys (kty OKP, crv Ed25519) are accepted." };
  if (typeof j.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(j.x)) return { ok: false, reason: "The public key value (x) must be 32 bytes, base64url." };
  const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x: j.x });
  if (typeof j.kid === "string" && j.kid !== kid) return { ok: false, reason: `The kid must be the RFC 7638 thumbprint of the key: ${kid}.` };
  const jwk: PublicJwk = { kty: "OKP", crv: "Ed25519", x: j.x, kid, alg: "EdDSA", use: "sig", nbf: typeof j.nbf === "string" ? j.nbf : now.toISOString() };
  if (typeof j.exp === "string") jwk.exp = j.exp;
  return { ok: true, jwk };
}

export interface PreparedSigning {
  /** The exact ASCII string the client signs with Ed25519: base64url(header) + "." + base64url(payload). */
  signing_input: string;
  protected_b64: string;
  payload_b64: string;
  header: JwsHeader;
  /** The statement type the client is signing, so its tooling can show it. */
  typ: typeof JWS_TYPES.semantoVersion;
}

/** Build the detached-JWS signing input for a version header. The client signs utf8(signing_input) with its private key. */
export function versionSigningInput(header: SemantoHeader, kid: string, iat: Date = new Date()): PreparedSigning {
  const jwsHeader: JwsHeader = { alg: "EdDSA", kid, typ: JWS_TYPES.semantoVersion, iat: iat.toISOString(), nbf: header.not_before, ...(header.not_after ? { exp: header.not_after } : {}) };
  const protected_b64 = toBase64Url(utf8(canonicalize(jwsHeader)));
  const payload_b64 = toBase64Url(utf8(canonicalize(header)));
  return { signing_input: `${protected_b64}.${payload_b64}`, protected_b64, payload_b64, header: jwsHeader, typ: JWS_TYPES.semantoVersion };
}

/** Put the client's 64-byte signature onto the prepared input. Returns both serializations. */
export function assembleJws(prepared: PreparedSigning, signature: Uint8Array): { detached: string; compact: string } {
  if (signature.length !== 64) throw new Error("assembleJws: an Ed25519 signature is 64 bytes");
  const s = toBase64Url(signature);
  return { detached: `${prepared.protected_b64}..${s}`, compact: `${prepared.protected_b64}.${prepared.payload_b64}.${s}` };
}

/** Check an assembled detached JWS against the header and the company's public key. */
export async function checkAssembledJws(detached: string, header: SemantoHeader, key: PublicJwk, at: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const v = await verifyJws(detached, (kid) => (kid === key.kid ? key : null), { expectTyp: JWS_TYPES.semantoVersion, payload: header, at });
  if (!v.ok) return { ok: false, reason: v.reason };
  const kv = keyValidAt(key, new Date(v.header.iat));
  if (!kv.ok) return { ok: false, reason: `key ${kv.reason} at signing time` };
  return { ok: true };
}

export { toPublic };
