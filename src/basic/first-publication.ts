// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// First-publication proof: for a post or page, Trooth witnesses the text at
// an address on a date, signs that statement (JWS typ first-publication) and
// appends a leaf to the public log. Later, anyone can recompute the hash from
// the markdown and check the signature, and the owner can hand a platform a
// plain-words statement in a copying dispute. The model is a timestamping
// service in the RFC 3161 sense, with the log entry making the timestamp
// publicly auditable (RFC 6962 style), applied to the extracted markdown of a
// page rather than to an arbitrary file.
//
// What Trooth witnessed is only the address, the fingerprint of the text and
// the moment: url, content_hash, witnessed_at. A title or an author the
// requester gave sits in a separate "declared" block, labelled as stated by
// the requester, so nobody reads them as witnessed. Anyone can check a record
// at GET /public/semanto/first-publication/{smb_id} (the record, its JWS and
// its log inclusion proof) and compare text with it at
// POST /public/semanto/first-publication/check.

import { canonicalize } from "../core/canonical";
import { utf8, toHex } from "../core/encoding";
import { digest, isDigest } from "../core/hash";
import { semantoId, isSemantoId } from "../core/ids";
import { JWS_TYPES, signObject, verifyJws, type JwsFailure } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import { leafHash } from "../core/merkle";
import type { LogLeaf, LogPort } from "./ports";

export interface FirstPublication {
  object: "semanto.first_publication";
  /** smb_ id: digest of the canonical record without `id`. */
  id: string;
  /** Witnessed: the address Trooth read. */
  url: string;
  /** Witnessed: the digest of the extracted markdown bytes. */
  content_hash: string;
  /** Witnessed: ISO 8601, when Trooth read the text. */
  witnessed_at: string;
  /** Who asked Trooth to witness the page. */
  trooth_id: string;
  /** Stated by the requester, not witnessed by Trooth: the title and author they gave. */
  declared: { stated_by: "requester"; title?: string; author?: string };
}

export interface FirstPublicationRecord {
  record: FirstPublication;
  /** Compact JWS over the record, typ first-publication, signed by Trooth's witness key. */
  jws: string;
  leaf: LogLeaf;
  /** Digest of the RFC 6962 leaf hash, for the log. */
  leaf_hash: string;
  log: { index: number; tree_size: number } | null;
}

export interface FirstPublicationInput {
  url: string;
  markdown: string;
  title: string;
  author?: string;
  trooth_id: string;
  witnessed_at: Date;
}

export function firstPublicationLeaf(r: FirstPublication): LogLeaf {
  return { kind: "first_publication", trooth_id: r.trooth_id, ref: r.id, hash: r.content_hash, at: r.witnessed_at };
}

export async function leafHashOf(leaf: LogLeaf): Promise<string> {
  return `sha256:${toHex(await leafHash(utf8(canonicalize(leaf))))}`;
}

/** Witness, sign and append. `log` may be omitted to sign without appending (the caller appends later). */
export async function createFirstPublication(input: FirstPublicationInput, witnessKey: PrivateJwk, log?: LogPort): Promise<FirstPublicationRecord> {
  if (!/^https:\/\//.test(input.url)) throw new Error("first publication: url must be https");
  const content_hash = await digest(utf8(input.markdown));
  const body: Omit<FirstPublication, "id"> = {
    object: "semanto.first_publication",
    url: input.url,
    content_hash,
    witnessed_at: input.witnessed_at.toISOString(),
    trooth_id: input.trooth_id,
    declared: { stated_by: "requester", ...(input.title ? { title: input.title } : {}), ...(input.author ? { author: input.author } : {}) },
  };
  const id = semantoId("smb", await digest(canonicalize(body)));
  const record: FirstPublication = { id, ...body };
  const signed = await signObject(record, witnessKey, JWS_TYPES.firstPublication, { iat: input.witnessed_at });
  const leaf = firstPublicationLeaf(record);
  const leaf_hash = await leafHashOf(leaf);
  const appended = log ? await log.append(leaf) : null;
  return { record, jws: signed.compact, leaf, leaf_hash, log: appended };
}

export type FirstPublicationCheck =
  | { ok: true; record: FirstPublication }
  | { ok: false; reason: "content_changed" | "id_mismatch" | JwsFailure; words: string };

/** Recompute the hash from the markdown and check Trooth's signature. */
export async function verifyFirstPublication(record: FirstPublication, jws: string, markdown: string, resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null): Promise<FirstPublicationCheck> {
  if (!isSemantoId(record.id, "smb") || !isDigest(record.content_hash)) return { ok: false, reason: "malformed", words: "The record is not well formed." };
  const { id, ...rest } = record;
  if (semantoId("smb", await digest(canonicalize(rest))) !== id) return { ok: false, reason: "id_mismatch", words: "The record id does not match its contents." };
  // The record is the expected payload: an embedded payload that is not this record is payload_mismatch.
  const v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.firstPublication, payload: record });
  if (!v.ok) return { ok: false, reason: v.reason, words: v.reason === "payload_mismatch" ? "The signature is over a different record." : `Trooth's signature did not check out: ${v.reason.replace(/_/g, " ")}.` };
  const now = await digest(utf8(markdown));
  if (now !== record.content_hash) return { ok: false, reason: "content_changed", words: "The text given is not the text Trooth witnessed. The hash differs." };
  return { ok: true, record };
}

/** Plain words a person can hand to a platform in a copying dispute. */
export function exportDisputeStatement(r: FirstPublicationRecord, opts: { log_url: string; record_url: string; check_url: string }): string {
  const date = r.record.witnessed_at.slice(0, 10);
  const where = r.log ? `The record is in a public log at index ${r.log.index} (tree size ${r.log.tree_size}) at ${opts.log_url}.` : "The record has been signed and is waiting to be added to the public log.";
  const d = r.record.declared;
  return [
    `Trooth witnessed this text at this address on this date.`,
    ``,
    `Address: ${r.record.url}`,
    `Date witnessed: ${date} (${r.record.witnessed_at})`,
    `Text fingerprint: ${r.record.content_hash}`,
    `Record id: ${r.record.id}`,
    ...(d.title || d.author ? [``, `Stated by the person who asked, not witnessed by Trooth:`, ...(d.title ? [`Title: ${d.title}`] : []), ...(d.author ? [`Author: ${d.author}`] : [])] : []),
    ``,
    where,
    ``,
    `What this means: on ${date}, Trooth read the text at the address above and recorded a fingerprint of it, signed with Trooth's key. The record, its signature and its place in the log are at ${opts.record_url}. Anyone can compare a text with it by sending { "record_id": "${r.record.id}", "markdown": "<the text>" } to ${opts.check_url}, which answers matches or differs. It shows the text existed at that address on that date. It does not by itself show who wrote it or who copied whom; a later date on another copy is what a platform compares.`,
    ``,
    `Signed statement (JWS): ${r.jws}`,
  ].join("\n");
}

/** What GET /public/semanto/first-publication/{smb_id} answers. */
export interface FirstPublicationDocument {
  object: "semanto.first_publication_record";
  record: FirstPublication;
  jws: string;
  leaf: LogLeaf;
  leaf_hash: string;
  /** The record's inclusion proof in the public log against the latest tree head, when it is logged. */
  inclusion: { index: number; tree_size: number; leaf_hash: string; root_hash: string; path: string[] } | null;
  check_url: string;
}

/** What POST /public/semanto/first-publication/check answers. Never a verdict about who wrote the text. */
export interface FirstPublicationCheckAnswer {
  object: "semanto.first_publication_check";
  record_id: string;
  status: "matches" | "differs";
  /** The digest of the markdown sent. */
  content_hash: string;
  /** The digest Trooth witnessed. */
  witnessed_hash: string;
  witnessed_at: string;
  url: string;
  record: FirstPublication;
  jws: string;
  inclusion: FirstPublicationDocument["inclusion"];
}

/** Compare a text with a record: matches when the digest of its UTF-8 bytes is the witnessed content_hash. */
export async function checkAgainstRecord(doc: FirstPublicationDocument, markdown: string): Promise<FirstPublicationCheckAnswer> {
  const content_hash = await digest(utf8(markdown));
  return {
    object: "semanto.first_publication_check",
    record_id: doc.record.id,
    status: content_hash === doc.record.content_hash ? "matches" : "differs",
    content_hash,
    witnessed_hash: doc.record.content_hash,
    witnessed_at: doc.record.witnessed_at,
    url: doc.record.url,
    record: doc.record,
    jws: doc.jws,
    inclusion: doc.inclusion,
  };
}
