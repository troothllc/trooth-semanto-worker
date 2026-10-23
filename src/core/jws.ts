// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// JSON Web Signatures (RFC 7515) with EdDSA (RFC 8037) over canonical JSON
// (RFC 8785). A Semanto version, a witness statement, a receipt and a signed
// tree head are all JWS objects in compact serialization, with the payload
// detached when it is large (RFC 7797, b64=false is NOT used; the detached
// payload is the canonical bytes, which any verifier can recompute).

import { toBase64Url, fromBase64Url, utf8, fromUtf8 } from "./encoding";
import { canonicalize } from "./canonical";
import { importPrivate, importPublic, sign as rawSign, verify as rawVerify, type PrivateJwk, type PublicJwk } from "./keys";

export interface JwsHeader {
  alg: "EdDSA";
  kid: string;
  /** What is signed, as a Trooth type URI, so a signature is never replayed as a different kind of statement. */
  typ: string;
  /** When the signature was made, ISO 8601. */
  iat: string;
  /** Validity bounds of the signed statement itself (not the key). */
  nbf?: string;
  exp?: string;
}

export interface CompactJws {
  /** header.payload.signature, payload present. */
  compact: string;
  /** header..signature, payload detached. */
  detached: string;
  header: JwsHeader;
  payloadB64: string;
}

export async function signObject(payload: unknown, priv: PrivateJwk, typ: string, opts: { iat?: Date; nbf?: Date; exp?: Date } = {}): Promise<CompactJws> {
  const header: JwsHeader = {
    alg: "EdDSA",
    kid: priv.kid,
    typ,
    iat: (opts.iat ?? new Date()).toISOString(),
    ...(opts.nbf ? { nbf: opts.nbf.toISOString() } : {}),
    ...(opts.exp ? { exp: opts.exp.toISOString() } : {}),
  };
  const h = toBase64Url(utf8(canonicalize(header)));
  const p = toBase64Url(utf8(canonicalize(payload)));
  const key = await importPrivate(priv);
  const sig = toBase64Url(await rawSign(key, utf8(`${h}.${p}`)));
  return { compact: `${h}.${p}.${sig}`, detached: `${h}..${sig}`, header, payloadB64: p };
}

export type JwsFailure =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_type"
  | "not_yet_valid"
  | "expired"
  | "payload_mismatch"
  | "key_not_yet_valid"
  | "key_expired"
  | "key_revoked";

export type JwsVerification =
  | {
      ok: true;
      header: JwsHeader;
      payload: unknown;
      /** Plain sentences a reader can weigh, such as "key revoked after signing on <date>". Empty when there is nothing to add. */
      notes: string[];
    }
  | { ok: false; reason: JwsFailure };

/** An ISO 8601 instant in a JWS header or a JWK: absent is fine, present must parse. */
function instant(v: unknown): number | null | "bad" {
  if (v === undefined) return null;
  if (typeof v !== "string") return "bad";
  const t = Date.parse(v);
  return Number.isNaN(t) ? "bad" : t;
}

/**
 * Key validity at the moment the statement was signed (its iat), not at the
 * moment it is checked. A key that was valid at iat verifies even after it
 * was rotated out (exp passed later) or revoked later; a revocation after iat
 * is returned as a note so a reader can weigh it. A key revoked at or before
 * iat fails. Revocation for compromise backdates revoked_at to the moment of
 * compromise, which then invalidates every signature made after it
 * (docs/spec/semanto-file.md, "Key validity").
 */
export function keyValidAtSigning(jwk: PublicJwk, iatMs: number): { ok: true; notes: string[] } | { ok: false; reason: "key_not_yet_valid" | "key_expired" | "key_revoked" | "malformed" } {
  const nbf = instant(jwk.nbf);
  const exp = instant(jwk.exp);
  const rev = instant(jwk.revoked_at);
  if (nbf === "bad" || exp === "bad" || rev === "bad") return { ok: false, reason: "malformed" };
  if (nbf !== null && iatMs < nbf) return { ok: false, reason: "key_not_yet_valid" };
  if (exp !== null && iatMs >= exp) return { ok: false, reason: "key_expired" };
  if (rev !== null && iatMs >= rev) return { ok: false, reason: "key_revoked" };
  const notes: string[] = [];
  if (rev !== null) notes.push(`key revoked after signing on ${jwk.revoked_at}`);
  return { ok: true, notes };
}

/**
 * Verify a compact or detached JWS.
 *
 * When the caller passes the payload it expects, the JWS payload segment must
 * be empty (detached) or byte-equal to base64url(canonical(expected));
 * anything else is "payload_mismatch". Without this rule, a published detached
 * signature plus the public old payload makes a compact JWS that "verifies"
 * whatever new object sits beside it. Without an expected payload, the
 * embedded payload is what is checked and returned, and the caller must
 * compare it to the object it meant to check.
 *
 * The key must have been valid at the statement's iat (keyValidAtSigning);
 * the statement's own nbf and exp are judged at `at`. A header whose iat, nbf
 * or exp does not parse, or that is not a JSON object, is malformed.
 */
export async function verifyJws(
  jws: string,
  resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null,
  opts: { expectTyp?: string; payload?: unknown; at?: Date } = {},
): Promise<JwsVerification> {
  if (typeof jws !== "string") return { ok: false, reason: "malformed" };
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, pGiven, s] = parts as [string, string, string];
  let header: JwsHeader;
  try {
    const parsed = JSON.parse(fromUtf8(fromBase64Url(h))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
    header = parsed as JwsHeader;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  if (opts.expectTyp && header.typ !== opts.expectTyp) return { ok: false, reason: "wrong_type" };
  const iat = instant(header.iat);
  const nbf = instant(header.nbf);
  const exp = instant(header.exp);
  if (iat === "bad" || nbf === "bad" || exp === "bad") return { ok: false, reason: "malformed" };
  let p: string;
  if (opts.payload !== undefined) {
    let expected: string;
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
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const good = await rawVerify(await importPublic(jwk), sig, utf8(`${h}.${p}`));
  if (!good) return { ok: false, reason: "bad_signature" };
  const at = (opts.at ?? new Date()).getTime();
  // A statement without iat is judged at `at`, the stricter choice.
  const kv = keyValidAtSigning(jwk, iat ?? at);
  if (!kv.ok) return { ok: false, reason: kv.reason };
  if (nbf !== null && at < nbf) return { ok: false, reason: "not_yet_valid" };
  if (exp !== null && at >= exp) return { ok: false, reason: "expired" };
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(p)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, header, payload, notes: kv.notes };
}

/** Trooth statement types. Registry: add here, never reuse. */
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
  sellerList: "https://trooth.co/types/seller-list",
} as const;
