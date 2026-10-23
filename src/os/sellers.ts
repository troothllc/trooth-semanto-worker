// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Seller lists (contract section 4): the company's signed list of who may
// sell its products, the way ads.txt and app-ads.txt name authorized sellers
// in one file the brand publishes, and Amazon Brand Registry and Google's
// Merchant Center authorized-reseller programs keep one list per brand.
//
//   custody customer   a compact JWS (typ JWS_TYPES.sellerList) over
//                      { trooth_id, version, issued_at, sellers }
//   custody hosted     the draft and a passkey assertion bound to that exact
//                      draft; the server signs with the hosted key after the
//                      check, as version signing does
//
// A list is checked against the company's key valid at issued_at; a bad
// signature answers 422 seller_list_signature and stores nothing. Versions
// only go up. The public sellers route and the authorization check read the
// newest valid list only; valid, superseded and invalid are computed on read
// (a key revoked back to before issued_at makes a stored list invalid).

import { canonicalize } from "../core/canonical";
import { JWS_TYPES, keyValidAtSigning, signObject, verifyJws } from "../core/jws";
import { fromBase64Url, fromUtf8 } from "../core/encoding";
import type { PublicJwk } from "../core/keys";
import { checkPurposeAssertion } from "../pipeline-passkeys";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { ADMIN_ONLY, audit, iso, isRecord, mayAdminister, ok, problem, type RequestContext } from "./common";
import type { OsService } from "./service";
import type { SellerListRow } from "./store";

export interface SellerEntry {
  seller_id: string;
  name: string;
  domain?: string;
  marketplace?: string;
  authorized_from: string;
  authorized_until?: string;
}

export interface SellerListPayload {
  trooth_id: string;
  version: number;
  issued_at: string;
  sellers: SellerEntry[];
}

export const MAX_SELLERS = 5000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const TOP_KEYS = new Set(["trooth_id", "version", "issued_at", "sellers"]);
const ENTRY_KEYS = new Set(["seller_id", "name", "domain", "marketplace", "authorized_from", "authorized_until"]);

/** Plain sentences for each problem in a payload; empty when it is usable. */
export function validateSellerList(input: unknown, trooth_id: string): string[] {
  const out: string[] = [];
  if (!isRecord(input)) return ["The seller list must be a JSON object { trooth_id, version, issued_at, sellers }."];
  for (const k of Object.keys(input)) if (!TOP_KEYS.has(k)) out.push(`${k} is not a seller list field.`);
  if (input.trooth_id !== trooth_id) out.push(`trooth_id must be ${trooth_id}.`);
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) out.push("version is a whole number, 1 or more.");
  if (typeof input.issued_at !== "string" || !ISO.test(input.issued_at)) out.push("issued_at is an ISO 8601 UTC time.");
  if (!Array.isArray(input.sellers) || input.sellers.length === 0 || input.sellers.length > MAX_SELLERS) {
    out.push(`sellers is a list of 1 to ${MAX_SELLERS} sellers.`);
    return out;
  }
  const ids = new Set<string>();
  input.sellers.forEach((e: unknown, i: number) => {
    const at = `sellers[${i}]`;
    if (!isRecord(e)) return void out.push(`${at} must be an object.`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) out.push(`${at}.${k} is not a seller field.`);
    if (typeof e.seller_id !== "string" || !e.seller_id.trim() || e.seller_id.length > 200) out.push(`${at}.seller_id is required, at most 200 characters.`);
    else if (ids.has(e.seller_id)) out.push(`${at}.seller_id ${e.seller_id} appears twice.`);
    else ids.add(e.seller_id);
    if (typeof e.name !== "string" || !e.name.trim() || e.name.length > 200) out.push(`${at}.name is required, at most 200 characters.`);
    if (e.domain !== undefined && (typeof e.domain !== "string" || !DOMAIN.test(e.domain))) out.push(`${at}.domain is a lowercase domain name.`);
    if (e.marketplace !== undefined && (typeof e.marketplace !== "string" || !e.marketplace.trim() || e.marketplace.length > 100)) out.push(`${at}.marketplace is a name of at most 100 characters.`);
    if (e.domain === undefined && e.marketplace === undefined) out.push(`${at} needs a domain or a marketplace.`);
    if (typeof e.authorized_from !== "string" || !ISO.test(e.authorized_from)) out.push(`${at}.authorized_from is an ISO 8601 UTC time.`);
    if (e.authorized_until !== undefined && (typeof e.authorized_until !== "string" || !ISO.test(e.authorized_until) || (typeof e.authorized_from === "string" && Date.parse(e.authorized_until) <= Date.parse(e.authorized_from)))) out.push(`${at}.authorized_until is an ISO 8601 UTC time after authorized_from.`);
  });
  return out;
}

/** A compact JWS's payload, or null. */
function payloadOf(jws: string): unknown {
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(fromUtf8(fromBase64Url(parts[1]))) as unknown;
  } catch {
    return null;
  }
}

/** Check a list's JWS against the company's keys: the type, the signature, and the key valid at both the JWS iat and issued_at. */
export async function checkSellerListJws(jws: string, payload: SellerListPayload, keys: { public_jwk: PublicJwk; next?: boolean }[], now: Date): Promise<{ ok: true; kid: string } | { ok: false; reason: string }> {
  const resolve = (kid: string) => keys.find((k) => k.public_jwk.kid === kid && !k.next)?.public_jwk ?? null;
  const v = await verifyJws(jws, resolve, { expectTyp: JWS_TYPES.sellerList, at: now });
  if (!v.ok) return { ok: false, reason: v.reason };
  if (canonicalize(v.payload) !== canonicalize(payload)) return { ok: false, reason: "payload_mismatch" };
  const kv = keyValidAtSigning(resolve(v.header.kid)!, Date.parse(payload.issued_at));
  if (!kv.ok) return { ok: false, reason: `${kv.reason} at issued_at` };
  return { ok: true, kid: v.header.kid };
}

/** Every stored list with its state now: the newest list whose signature still checks out is valid, older ones superseded. */
export async function sellerListStates(s: OsService, trooth_id: string): Promise<{ row: SellerListRow; state: "valid" | "superseded" | "invalid"; reason: string | null }[]> {
  const rows = await s.store.sellerLists(trooth_id);
  const keys = await s.p.d.store.keys(trooth_id);
  const now = s.now();
  let seenValid = false;
  const out: { row: SellerListRow; state: "valid" | "superseded" | "invalid"; reason: string | null }[] = [];
  for (const row of rows) {
    const check = await checkSellerListJws(row.jws, row.payload as SellerListPayload, keys, now);
    if (!check.ok) out.push({ row, state: "invalid", reason: check.reason });
    else {
      out.push({ row, state: seenValid ? "superseded" : "valid", reason: null });
      seenValid = true;
    }
  }
  return out;
}

/** The newest valid list, or null. */
export async function newestValidSellerList(s: OsService, trooth_id: string): Promise<{ row: SellerListRow; payload: SellerListPayload } | null> {
  const v = (await sellerListStates(s, trooth_id)).find((x) => x.state === "valid");
  return v ? { row: v.row, payload: v.row.payload as SellerListPayload } : null;
}

const sig = (detail: string): WorkspaceResult => problem("seller_list_signature", detail);

/** POST /os/semanto/{id}/sellers/lists. */
export async function submitSellerList(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("publish a seller list");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const now = s.now();
  let jws: string;
  let payload: SellerListPayload;
  let custody: "hosted" | "customer";
  if (typeof body.jws === "string") {
    const raw = payloadOf(body.jws);
    if (raw === null) return problem("invalid_request", "jws must be a compact JWS (header.payload.signature) with the list as its payload.");
    const issues = validateSellerList(raw, trooth_id);
    if (issues.length) return problem("invalid_request", issues.join(" "));
    payload = raw as SellerListPayload;
    const check = await checkSellerListJws(body.jws, payload, await s.p.d.store.keys(trooth_id), now);
    if (!check.ok) return sig(`The signature did not check out (${check.reason}). Nothing was stored.`);
    jws = body.jws;
    custody = "customer";
  } else if (body.draft !== undefined) {
    if (company.custody !== "hosted") return problem("conflict", "Your company holds its own signing key. Sign the list yourself and send it as jws.");
    const issues = validateSellerList(body.draft, trooth_id);
    if (issues.length) return problem("invalid_request", issues.join(" "));
    payload = body.draft as SellerListPayload;
    const checked = await checkPurposeAssertion(s.p, ws, trooth_id, "seller_list", canonicalize(payload), body);
    if (!checked.ok) return checked.result;
    const key = await s.p.d.keys.getCompanySigningKey(trooth_id);
    if (!key) return problem("conflict", "There is no hosted signing key to sign with yet. Sign a version first.");
    const signed = await signObject(payload, key, JWS_TYPES.sellerList, { iat: now });
    const check = await checkSellerListJws(signed.compact, payload, await s.p.d.store.keys(trooth_id), now);
    if (!check.ok) return sig(`The hosted key was not valid at issued_at (${check.reason}). Nothing was stored.`);
    jws = signed.compact;
    custody = "hosted";
  } else return problem("invalid_request", 'Send { "jws": "<compact JWS>" } when you hold your key, or { "draft": <list>, "assertion": <passkey answer> } when Trooth holds it.');
  const newest = (await s.store.sellerLists(trooth_id))[0];
  if (newest && payload.version <= newest.version) return problem("conflict", `Version ${payload.version} is not newer than version ${newest.version} on file. Seller lists only go up; send version ${newest.version + 1} or higher.`);
  const kid = JSON.parse(fromUtf8(fromBase64Url(jws.split(".")[0]!))) as { kid: string };
  const row: SellerListRow = { trooth_id, version: payload.version, jws, kid: kid.kid, issued_at: payload.issued_at, payload, custody, submitted_by: ws.user_id, submitted_at: iso(now) };
  if (!(await s.store.putSellerList(row))) {
    const top = (await s.store.sellerLists(trooth_id))[0];
    return problem("conflict", `Version ${payload.version} is not newer than version ${top?.version ?? payload.version} on file (another submission landed first). Seller lists only go up; send version ${(top?.version ?? payload.version) + 1} or higher.`);
  }
  await audit(s.store, { trooth_id, ws, action: "sellers.list", target: `v${payload.version}`, before: newest ? { version: newest.version } : null, after: { version: payload.version, sellers: payload.sellers.length, kid: row.kid }, ctx, at: now });
  return ok(201, { object: "semanto.seller_list", trooth_id, version: payload.version, state: "valid", kid: row.kid, issued_at: payload.issued_at, sellers: payload.sellers.length, custody, jws });
}

/** GET /os/semanto/{id}/sellers/lists. */
export async function listSellerLists(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  const states = await sellerListStates(s, trooth_id);
  return ok(200, {
    object: "semanto.seller_lists",
    trooth_id,
    // The version a new list must carry, so the form can fill it in: one more than the newest on file.
    next_version: (states[0]?.row.version ?? 0) + 1,
    lists: states.map(({ row, state, reason }) => ({ version: row.version, issued_at: row.issued_at, state, sellers_count: (row.payload as SellerListPayload).sellers.length, received_at: row.submitted_at, kid: row.kid, reason, custody: row.custody })),
  });
}

/** POST /os/semanto/{id}/sellers/lists/options with { draft }: the passkey request bound to this person and this exact draft (custody hosted). */
export async function sellerListOptions(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("publish a seller list");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  if (company.custody !== "hosted") return problem("conflict", "Your company holds its own signing key. Sign the list yourself and send it as jws.");
  const issues = validateSellerList(body.draft, trooth_id);
  if (issues.length) return problem("invalid_request", issues.join(" "));
  return s.p.handle("sign/options", ws, trooth_id, { purpose: "seller_list", draft: body.draft });
}

export type SellerListAnswer = { state: "authorized" | "not_listed" | "expired"; seller_id?: string; list_version: number };

/** The authorization check against the newest valid list: a domain or a marketplace named in it, inside its window. Pure. */
export function sellerListAuthorization(list: SellerListPayload, who: string, now: Date): SellerListAnswer {
  const q = who.trim().toLowerCase();
  const t = now.getTime();
  const matches = list.sellers.filter((e) => e.domain?.toLowerCase() === q || e.marketplace?.toLowerCase() === q || e.seller_id.toLowerCase() === q);
  const live = matches.find((e) => Date.parse(e.authorized_from) <= t && (!e.authorized_until || t < Date.parse(e.authorized_until)));
  if (live) return { state: "authorized", seller_id: live.seller_id, list_version: list.version };
  const ended = matches.find((e) => e.authorized_until && t >= Date.parse(e.authorized_until));
  if (ended) return { state: "expired", seller_id: ended.seller_id, list_version: list.version };
  return { state: "not_listed", list_version: list.version };
}
