// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Recall and safety notices. A brand or seller signs a notice naming skus or
// GTINs (and lots, when the recall is by lot), the authority behind it when
// there is one (for example the U.S. Consumer Product Safety Commission with
// its recall page), the action a buyer must take, and the statement. A
// recalled item answers "recalled" for availability whatever its stock, and
// the notice appears in the company's change feed within one polling cycle.
// Fields follow the CPSC recall record (cpsc.gov/Recalls, 2026 fields: title,
// hazard, remedy, units) and the GS1 Product Recall standard (GS1 Recall,
// release 1.3) for identifying the product by GTIN and lot. Signed as a JWS
// (RFC 7515, RFC 8037, RFC 8785).

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId, isSemantoId } from "../core/ids";
import { signObject, verifyJws, JWS_TYPES } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { ValidationIssue } from "../core/semanto";
import { isValidGtin, normalizeGtin } from "./product-record";
import type { Offer, Availability } from "./offers";

// ---------------------------------------------------------------- types

export type RecallAction = "stop_sale" | "stop_use" | "return" | "repair";
export const RECALL_ACTIONS: RecallAction[] = ["stop_sale", "stop_use", "return", "repair"];

export interface RecallNotice {
  object: "semanto.recall";
  /** smn_ id, the content address of the notice without its id. */
  id: string;
  /** At least one of skus or gtins. */
  skus?: string[];
  gtins?: string[];
  /** Lot or batch codes. Absent means every lot. */
  lots?: string[];
  issued_at: string;
  /** The public authority behind the recall, when there is one. */
  authority?: { name: string; url: string; reference?: string };
  action: RecallAction;
  statement: string;
  /** The notice on the issuer's own site. */
  url: string;
  /** When the issuer closed the recall, if it did. Absent means still in force. */
  closed_at?: string;
}

export type RecallNoticeInput = Omit<RecallNotice, "id" | "object"> & { object?: "semanto.recall"; id?: string };

export interface SignedRecall {
  notice: RecallNotice;
  jws: string;
  kid: string;
}

// ---------------------------------------------------------------- validation

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS = /^https:\/\//;

export function validateRecall(input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "not an object" }];
  const n = input as Partial<RecallNotice>;
  if (n.object !== undefined && n.object !== "semanto.recall") push("object", 'must be "semanto.recall"');
  const skus = Array.isArray(n.skus) ? n.skus : [];
  const gtins = Array.isArray(n.gtins) ? n.gtins : [];
  if (n.skus !== undefined && !Array.isArray(n.skus)) push("skus", "array");
  if (n.gtins !== undefined && !Array.isArray(n.gtins)) push("gtins", "array");
  if (skus.length === 0 && gtins.length === 0) push("skus", "name at least one sku or one gtin");
  gtins.forEach((g, i) => { if (!isValidGtin(g)) push(`gtins[${i}]`, "GTIN with a valid GS1 check digit"); });
  if (n.lots !== undefined && (!Array.isArray(n.lots) || n.lots.length === 0 || n.lots.some((l) => typeof l !== "string" || !l))) push("lots", "non-empty array of lot codes, or absent");
  if (typeof n.issued_at !== "string" || !ISO.test(n.issued_at)) push("issued_at", "ISO 8601 UTC");
  if (n.authority !== undefined && (typeof n.authority.name !== "string" || !n.authority.name || !HTTPS.test(n.authority.url ?? ""))) push("authority", "name and https url");
  if (!RECALL_ACTIONS.includes(n.action as RecallAction)) push("action", `one of ${RECALL_ACTIONS.join(", ")}`);
  if (typeof n.statement !== "string" || !n.statement.trim()) push("statement", "required");
  if (typeof n.url !== "string" || !HTTPS.test(n.url)) push("url", "https url");
  if (n.closed_at !== undefined && (!ISO.test(n.closed_at) || (typeof n.issued_at === "string" && Date.parse(n.closed_at) < Date.parse(n.issued_at)))) push("closed_at", "ISO 8601 UTC, not before issued_at");
  return out;
}

// ---------------------------------------------------------------- build, sign, verify

export function recallContent(input: RecallNoticeInput | RecallNotice): Omit<RecallNotice, "id"> {
  const copy: Record<string, unknown> = Object.assign({}, input) as Record<string, unknown>;
  delete copy.id;
  delete copy.signature;
  copy.object = "semanto.recall";
  return copy as unknown as Omit<RecallNotice, "id">;
}

export async function recallId(input: RecallNoticeInput | RecallNotice): Promise<string> {
  return semantoId("smn", await digest(canonicalize(recallContent(input))));
}

export async function buildRecall(input: RecallNoticeInput): Promise<RecallNotice> {
  const content = recallContent(input);
  const issues = validateRecall(content);
  if (issues.length) throw new Error(`recall: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return Object.assign({ id: await recallId(content) }, content) as RecallNotice;
}

/** A recall notice has a start and no end in the signature: it stays checkable after the recall closes. */
export async function signRecall(input: RecallNoticeInput, priv: PrivateJwk, opts: { iat?: Date } = {}): Promise<SignedRecall> {
  const notice = await buildRecall(input);
  const jws = await signObject(notice, priv, JWS_TYPES.recall, { iat: opts.iat ?? new Date(notice.issued_at), nbf: new Date(notice.issued_at) });
  return { notice, jws: jws.compact, kid: priv.kid };
}

export type RecallVerification =
  | { ok: true; notice: RecallNotice; kid: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "wrong_type" | "not_yet_valid" | "expired" | "id_mismatch" | "invalid_notice"; issues?: ValidationIssue[] };

export async function verifyRecall(jws: string, resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null, opts: { at?: Date } = {}): Promise<RecallVerification> {
  const v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.recall, at: opts.at });
  if (!v.ok) return { ok: false, reason: v.reason };
  const payload = v.payload as Partial<RecallNotice>;
  const issues = validateRecall(payload);
  if (payload.object !== "semanto.recall" || !isSemantoId(payload.id, "smn")) issues.push({ path: "id", message: "smn_ id required" });
  if (issues.length) return { ok: false, reason: "invalid_notice", issues };
  const notice = payload as RecallNotice;
  if ((await recallId(notice)) !== notice.id) return { ok: false, reason: "id_mismatch" };
  return { ok: true, notice, kid: v.header.kid };
}

// ---------------------------------------------------------------- change feed

/** The entry an agent polling company_changes sees. One per notice, within one polling cycle of signing. */
export interface RecallChangeEntry {
  object: "semanto.change";
  trooth_id: string;
  kind: "recall_issued" | "recall_closed";
  /** The smn_ id of the notice. */
  ref: string;
  at: string;
  action: RecallAction;
  skus: string[];
  gtins: string[];
  lots: string[] | "all";
  statement: string;
  url: string;
  authority: { name: string; url: string; reference?: string } | null;
  /** The signed notice, so the poller can check it without a second request. */
  jws: string;
}

export function recallChangeEntry(trooth_id: string, signed: SignedRecall): RecallChangeEntry {
  const n = signed.notice;
  return {
    object: "semanto.change",
    trooth_id,
    kind: n.closed_at ? "recall_closed" : "recall_issued",
    ref: n.id,
    at: n.closed_at ?? n.issued_at,
    action: n.action,
    skus: n.skus ?? [],
    gtins: n.gtins ?? [],
    lots: n.lots ?? "all",
    statement: n.statement,
    url: n.url,
    authority: n.authority ?? null,
    jws: signed.jws,
  };
}

// ---------------------------------------------------------------- effect on offers

export interface AffectedContext {
  /** The GTIN of the offered item, from its product record, so a GTIN recall can be matched. */
  gtin?: string;
  /** The lot being offered, when the seller knows it. Without it, a lot-scoped recall is treated as affecting the offer. */
  lot?: string;
  now?: Date;
}

export interface AffectedAnswer {
  recalled: boolean;
  notices: RecallNotice[];
  /** "sku", "gtin" or none. */
  matched_by: ("sku" | "gtin")[];
  /** True when a notice names lots and the seller gave none, so the match is by caution. */
  lot_unknown: boolean;
}

function inForce(n: RecallNotice, now: Date): boolean {
  const t = now.getTime();
  if (Date.parse(n.issued_at) > t) return false;
  if (n.closed_at && Date.parse(n.closed_at) <= t) return false;
  return true;
}

/** Does any notice in force name this offer's item? */
export function affected(offer: Pick<Offer, "sku">, notices: RecallNotice[], ctx: AffectedContext = {}): AffectedAnswer {
  const now = ctx.now ?? new Date();
  const matched: RecallNotice[] = [];
  const by = new Set<"sku" | "gtin">();
  let lot_unknown = false;
  for (const n of notices) {
    if (!inForce(n, now)) continue;
    let hit: "sku" | "gtin" | null = null;
    if (n.skus && n.skus.includes(offer.sku)) hit = "sku";
    else if (n.gtins && ctx.gtin && isValidGtin(ctx.gtin) && n.gtins.some((g) => normalizeGtin(g) === normalizeGtin(ctx.gtin!))) hit = "gtin";
    if (!hit) continue;
    if (n.lots) {
      if (ctx.lot === undefined) lot_unknown = true;
      else if (!n.lots.includes(ctx.lot)) continue;
    }
    matched.push(n);
    by.add(hit);
  }
  return { recalled: matched.length > 0, notices: matched, matched_by: Array.from(by), lot_unknown };
}

export type AvailabilityAnswer = Availability | "recalled";

/** The availability an agent should repeat: "recalled" overrides stock. */
export function availabilityAnswer(offer: Pick<Offer, "sku" | "availability">, notices: RecallNotice[], ctx: AffectedContext = {}): AvailabilityAnswer {
  return affected(offer, notices, ctx).recalled ? "recalled" : offer.availability;
}

/** The offer as answered to an agent: the signed offer untouched, plus the recall overlay. */
export interface OfferWithRecall {
  offer: Offer;
  availability_answer: AvailabilityAnswer;
  recalled: boolean;
  recall_ids: string[];
  recall_actions: RecallAction[];
  recall_urls: string[];
}

export function withRecallStatus(offer: Offer, notices: RecallNotice[], ctx: AffectedContext = {}): OfferWithRecall {
  const a = affected(offer, notices, ctx);
  return {
    offer,
    availability_answer: a.recalled ? "recalled" : offer.availability,
    recalled: a.recalled,
    recall_ids: a.notices.map((n) => n.id),
    recall_actions: Array.from(new Set(a.notices.map((n) => n.action))),
    recall_urls: a.notices.map((n) => n.url),
  };
}
