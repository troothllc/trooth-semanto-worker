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

export type JwsVerification =
  | { ok: true; header: JwsHeader; payload: unknown }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "wrong_type" | "not_yet_valid" | "expired" };

/**
 * Verify a compact or detached JWS. For a detached JWS, pass the payload
 * object; its canonical bytes are what was signed.
 */
export async function verifyJws(
  jws: string,
  resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null,
  opts: { expectTyp?: string; payload?: unknown; at?: Date } = {},
): Promise<JwsVerification> {
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, pGiven, s] = parts as [string, string, string];
  let header: JwsHeader;
  try {
    header = JSON.parse(fromUtf8(fromBase64Url(h))) as JwsHeader;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  if (opts.expectTyp && header.typ !== opts.expectTyp) return { ok: false, reason: "wrong_type" };
  const p = pGiven !== "" ? pGiven : opts.payload !== undefined ? toBase64Url(utf8(canonicalize(opts.payload))) : null;
  if (p === null) return { ok: false, reason: "malformed" };
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
  if (header.nbf && at < Date.parse(header.nbf)) return { ok: false, reason: "not_yet_valid" };
  if (header.exp && at >= Date.parse(header.exp)) return { ok: false, reason: "expired" };
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(p)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, header, payload };
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
  firstPublication: "https://trooth.co/types/first-publication",
  readReceipt: "https://trooth.co/types/read-receipt",
  revocation: "https://trooth.co/types/revocation-list",
  contentSignals: "https://trooth.co/types/content-signals",
} as const;
