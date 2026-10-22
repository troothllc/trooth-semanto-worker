// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ed25519 keys as JWKs (RFC 8037), with RFC 7638 thumbprints as key ids, and
// the JWK Set a company publishes at /.well-known/trooth-keys.json. Keys are
// handled through WebCrypto only; private material is never printed.
//
// Why Ed25519: Web Bot Auth (IETF, 2026) signs agent requests with Ed25519 and
// publishes keys as a JWK Set at a Signature-Agent URL. Semanto signs the
// answer with the same algorithm and the same key format, so the libraries
// agents already carry verify both directions.

import { toBase64Url, fromBase64Url, utf8 } from "./encoding";
import { sha256 } from "./hash";
import { canonicalize } from "./canonical";

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
  /** When this key may be used, ISO 8601. Absent means no bound. */
  nbf?: string;
  exp?: string;
  /** Set when the key was withdrawn; a signature made after this instant is not valid. */
  revoked_at?: string;
}

export interface PrivateJwk extends PublicJwk {
  d: string;
}

export interface Jwks {
  keys: PublicJwk[];
}

/** RFC 7638: the thumbprint of the required members only, in lexicographic order. */
export async function thumbprint(jwk: { kty: string; crv: string; x: string }): Promise<string> {
  const required = canonicalize({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return toBase64Url(await sha256(utf8(required)));
}

export async function generateKeyPair(): Promise<{ publicJwk: PublicJwk; privateJwk: PrivateJwk }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const kid = await thumbprint({ kty: "OKP", crv: "Ed25519", x: pub.x! });
  const publicJwk: PublicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x!, kid, alg: "EdDSA", use: "sig" };
  return { publicJwk, privateJwk: { ...publicJwk, d: priv.d! } };
}

export async function importPrivate(jwk: PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, { name: "Ed25519" }, false, ["sign"]);
}

export async function importPublic(jwk: { x: string }): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
}

export async function importPublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  return importPublic({ x: toBase64Url(raw) });
}

export const publicKeyBytes = (jwk: { x: string }): Uint8Array => fromBase64Url(jwk.x);

export async function sign(priv: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, data as BufferSource));
}

export async function verify(pub: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, signature as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

export function toPublic(jwk: PrivateJwk): PublicJwk {
  const { d: _d, ...pub } = jwk;
  return pub;
}

/** Is this key valid at `at`? Validity windows and revocation are checked by the verifier, never only by the signer. */
export function keyValidAt(jwk: PublicJwk, at: Date): { ok: true } | { ok: false; reason: "not_yet_valid" | "expired" | "revoked" } {
  const t = at.getTime();
  if (jwk.nbf && t < Date.parse(jwk.nbf)) return { ok: false, reason: "not_yet_valid" };
  if (jwk.exp && t >= Date.parse(jwk.exp)) return { ok: false, reason: "expired" };
  if (jwk.revoked_at && t >= Date.parse(jwk.revoked_at)) return { ok: false, reason: "revoked" };
  return { ok: true };
}

export function findKey(jwks: Jwks, kid: string): PublicJwk | null {
  return jwks.keys.find((k) => k.kid === kid) ?? null;
}

/** The DNS TXT record a domain publishes so a key is provably the domain's: "v=trooth1; kid=<thumbprint>". */
export function dnsKeyRecord(kid: string): string {
  return `v=trooth1; kid=${kid}`;
}

export function parseDnsKeyRecords(txt: string[]): string[] {
  const kids: string[] = [];
  for (const t of txt) {
    const m = /^v=trooth1;\s*kid=([A-Za-z0-9_-]{43})$/.exec(t.trim().replace(/^"|"$/g, ""));
    if (m) kids.push(m[1]!);
  }
  return kids;
}
