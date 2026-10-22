// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Validity and revocation for signed versions, keys, offers and records.
//
// A Semanto version is one of five things at a moment in time:
//   current     inside its window, the latest the company published
//   superseded  a later version names it (directly or down the supersedes chain)
//   behind      not the latest, but no later version links back to it; or the
//               reader's clock is before the version's not_before
//   withdrawn   the company or Trooth withdrew it (state or revocation list)
//   expired     past its not_after
//
// The revocation list is a signed statement (JWS typ JWS_TYPES.revocation)
// with a 24 hour validity window, the practice of a short-lived CRL
// (RFC 5280 section 5, nextUpdate) and of OCSP responses: a list that is too
// old is itself a finding, so a reader never mistakes silence for health.
// Every entry also becomes a leaf in the public log.

import { JWS_TYPES, signObject, verifyJws } from "@/core/jws";
import type { PrivateJwk, PublicJwk } from "@/core/keys";
import type { SemantoState } from "@/core/semanto";
import { digest } from "@/core/hash";
import { canonicalize } from "@/core/canonical";
import type { LogLeaf } from "./ports";

export type VersionState = "current" | "superseded" | "behind" | "withdrawn" | "expired";

export type RevocationKind = "version" | "key" | "offer" | "record";

export interface RevocationEntry {
  kind: RevocationKind;
  /** An smv_ id, a kid, an smo_ id or an smk_ id. */
  ref: string;
  /** Plain words, written by the person who withdrew it. */
  reason: string;
  revoked_at: string;
}

export const REVOCATION_LIST_TTL_MS = 24 * 60 * 60 * 1000;

export interface RevocationList {
  trooth_id: string | null;
  issued_at: string;
  /** issued_at plus 24 hours. A list read after this is stale. */
  next_update: string;
  revocations: RevocationEntry[];
}

export interface VersionRef {
  trooth_id: string;
  /** smv_ id. */
  id: string;
  version: number;
  supersedes: number | null;
  state: SemantoState;
  not_before: string;
  not_after: string | null;
}

/** What the reader knows about the newest version: its number, and the supersedes chain back from it when known. */
export type LatestKnown = number | { version: number; chain: number[] };

export interface StateResult {
  state: VersionState;
  /** One plain sentence an agent can show. */
  sentence: string;
  /** The revocation entry that withdrew it, when one did. */
  revocation?: RevocationEntry;
}

export function isRevoked(kind: RevocationKind, ref: string, revocations: RevocationEntry[], now: Date): RevocationEntry | null {
  const t = now.getTime();
  return revocations.find((r) => r.kind === kind && r.ref === ref && Date.parse(r.revoked_at) <= t) ?? null;
}

/** The five-state answer for a version. */
export function stateOf(version: VersionRef, now: Date, revocations: RevocationEntry[], latest: LatestKnown): StateResult {
  const t = now.getTime();
  const rev = isRevoked("version", version.id, revocations, now);
  if (version.state === "withdrawn" || rev) {
    const when = rev ? rev.revoked_at : null;
    return {
      state: "withdrawn",
      sentence: when ? `Version ${version.version} was withdrawn on ${day(when)}. ${rev?.reason ?? ""}`.trim() : `Version ${version.version} was withdrawn by the company.`,
      ...(rev ? { revocation: rev } : {}),
    };
  }
  if (version.not_after && t >= Date.parse(version.not_after)) {
    return { state: "expired", sentence: `Version ${version.version} expired on ${day(version.not_after)}. Ask for the current version.` };
  }
  if (t < Date.parse(version.not_before)) {
    return { state: "behind", sentence: `Version ${version.version} is not valid yet. It starts on ${day(version.not_before)}.` };
  }
  const latestVersion = typeof latest === "number" ? latest : latest.version;
  if (latestVersion > version.version) {
    const linked = typeof latest === "number" ? true : latest.chain.includes(version.version);
    if (linked) return { state: "superseded", sentence: `Version ${version.version} was replaced by version ${latestVersion}. Read the newer one.` };
    return { state: "behind", sentence: `Version ${version.version} is older than version ${latestVersion}, and the newer one does not name it. Read the newer one.` };
  }
  return { state: "current", sentence: `Version ${version.version} is the current signed version.` };
}

/** Walk a set of versions back from the newest to produce the supersedes chain. */
export function supersedesChain(versions: { version: number; supersedes: number | null }[]): { version: number; chain: number[] } | null {
  if (versions.length === 0) return null;
  const byNumber = new Map(versions.map((v) => [v.version, v]));
  const newest = Math.max(...versions.map((v) => v.version));
  const chain: number[] = [];
  let cur = byNumber.get(newest)?.supersedes ?? null;
  const seen = new Set<number>([newest]);
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = byNumber.get(cur)?.supersedes ?? null;
  }
  return { version: newest, chain };
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------- the signed list

export async function signRevocationList(entries: RevocationEntry[], troothId: string | null, key: PrivateJwk, issuedAt: Date = new Date()): Promise<{ list: RevocationList; jws: string }> {
  const list: RevocationList = {
    trooth_id: troothId,
    issued_at: issuedAt.toISOString(),
    next_update: new Date(issuedAt.getTime() + REVOCATION_LIST_TTL_MS).toISOString(),
    revocations: [...entries].sort((a, b) => (a.revoked_at < b.revoked_at ? -1 : a.revoked_at > b.revoked_at ? 1 : a.ref < b.ref ? -1 : 1)),
  };
  const jws = await signObject(list, key, JWS_TYPES.revocation, { iat: issuedAt, nbf: issuedAt, exp: new Date(issuedAt.getTime() + REVOCATION_LIST_TTL_MS) });
  return { list, jws: jws.compact };
}

export type RevocationListCheck =
  | { ok: true; list: RevocationList }
  | { ok: false; reason: "stale" | "not_yet_valid" | "bad_signature" | "wrong_type" | "malformed" | "unknown_key"; sentence: string };

/** Verify a list. A list past next_update is "stale", which a reader must treat as no answer, never as "nothing revoked". */
export async function verifyRevocationList(jws: string, key: PublicJwk, now: Date = new Date()): Promise<RevocationListCheck> {
  const v = await verifyJws(jws, (kid) => (kid === key.kid ? key : null), { expectTyp: JWS_TYPES.revocation, at: now });
  if (!v.ok) {
    if (v.reason === "expired") return { ok: false, reason: "stale", sentence: "The revocation list is more than 24 hours old. Treat it as missing, not as empty." };
    if (v.reason === "not_yet_valid") return { ok: false, reason: "not_yet_valid", sentence: "The revocation list is dated in the future. Check the clock." };
    return { ok: false, reason: v.reason, sentence: "The revocation list did not verify." };
  }
  const list = v.payload as Partial<RevocationList>;
  if (!Array.isArray(list.revocations) || typeof list.issued_at !== "string" || typeof list.next_update !== "string") return { ok: false, reason: "malformed", sentence: "The revocation list is malformed." };
  if (now.getTime() >= Date.parse(list.next_update)) return { ok: false, reason: "stale", sentence: "The revocation list is more than 24 hours old. Treat it as missing, not as empty." };
  return { ok: true, list: list as RevocationList };
}

/** The log leaf for one revocation, so the withdrawal itself is public and ordered. */
export async function revocationLeaf(entry: RevocationEntry, troothId: string | null): Promise<LogLeaf> {
  return { kind: "revocation", trooth_id: troothId, ref: entry.ref, hash: await digest(canonicalize(entry)), at: entry.revoked_at };
}

/** Key validity in words, for the dashboard and the verifier. */
export function keyState(key: PublicJwk, revocations: RevocationEntry[], now: Date): { state: "valid" | "not_yet_valid" | "expired" | "revoked"; sentence: string } {
  const rev = isRevoked("key", key.kid, revocations, now);
  if (rev || (key.revoked_at && now.getTime() >= Date.parse(key.revoked_at))) return { state: "revoked", sentence: `This key was withdrawn on ${day(rev?.revoked_at ?? key.revoked_at!)}. Signatures made after that are not valid.` };
  if (key.nbf && now.getTime() < Date.parse(key.nbf)) return { state: "not_yet_valid", sentence: `This key starts on ${day(key.nbf)}.` };
  if (key.exp && now.getTime() >= Date.parse(key.exp)) return { state: "expired", sentence: `This key expired on ${day(key.exp)}. Signatures made before that still hold.` };
  return { state: "valid", sentence: "This key is valid now." };
}
