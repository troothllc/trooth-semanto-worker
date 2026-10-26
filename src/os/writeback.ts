// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Google write-back that sends (contract section 3). The preview
// (src/monitor/writeback.ts, unchanged) gains one item per proposed change,
// each with a content-addressed item_id, so the same change keeps the same
// id and a stale id never sends. Send takes a confirmation and an
// idempotency key (Stripe's Idempotency-Key: the same key answers the same
// run), creates a run with one item per change and enqueues one queue
// message per item. The queue consumer refreshes the Google token on use and
// sends:
//
//   Merchant Center   POST merchantapi.googleapis.com/products/v1/accounts/
//                     {account}/productInputs:insert?dataSource={data source}, one
//                     ProductInput per product (an insert with the same
//                     offerId replaces the earlier input)
//   Business Profile  PATCH mybusinessbusinessinformation.googleapis.com/v1/
//                     locations/{id}?updateMask={fields}
//
// On 429 or 5xx the message is retried after 30, 120 and 600 seconds
// (queue retry with delaySeconds) up to the queue's attempts; on another 4xx
// the item fails with Google's own message in plain words; on invalid_grant
// it fails as needs_reconnect. Failed items can be retried from the run.
// Every image link sent gets a credential job (src/os/credentials.ts).

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { merchantInsertUrl, merchantProductInputs, type WritebackPayload } from "../monitor/writeback";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { ADMIN_ONLY, audit, backoffFor, decodeCursor, encodeCursor, iso, isRecord, mayAdminister, ok, problem, QUEUE_ATTEMPTS, randomId, RetryLater, str, type RequestContext } from "./common";
import { googleAccessToken } from "./google";
import { queueCredential } from "./credentials";
import type { OsService } from "./service";
import type { WritebackMessage } from "../env";
import type { WritebackConnectorName, WritebackItem, WritebackRequest } from "./store";

/** One proposed change: a preview payload with its item_id. Only http payloads can be sent; files are uploaded or published by the company. */
export interface ProposedItem {
  item_id: string;
  connector: string;
  /** The account or location the change goes to, or the file's address. */
  target: string;
  transport: "http" | "file";
  method: string | null;
  url: string | null;
  content_type: string;
  body: string;
  dry_run: string;
  needs: string;
  carries: Record<string, unknown>;
  /** False when the send needs something first, or when the payload is a file; blocked_by says what. */
  ready: boolean;
  blocked_by?: string;
  request?: WritebackRequest;
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

async function itemId(p: { connector: string; transport: string; url: string | null; body: string }): Promise<string> {
  return `wbi_${(await digest(canonicalize({ connector: p.connector, transport: p.transport, url: p.url, body: p.body }))).slice(7, 39)}`;
}

/**
 * Every change write-back would make now, one per preview payload, built from
 * the signed record and the connected targets. Merchant Center is one item
 * for the whole catalog, sent as one productInputs.insert per product through
 * the Merchant API; the preview's per-product requests are folded into it, and
 * it is shown (blocked, with the reason) before a data source is chosen.
 */
export async function proposedItems(s: OsService, trooth_id: string): Promise<ProposedItem[] | null> {
  const base = await s.p.read("writeback", { trooth_id, role: "owner", user_id: "writeback", name: "write-back" }, trooth_id, {});
  if (base.problem || !isRecord(base.body)) return null;
  const record = await s.p.signedRecord(trooth_id);
  if (!record) return null;
  const config = await s.p.d.store.getConfig(trooth_id);
  const mc = config.writeback?.merchant_center;
  const out: ProposedItem[] = [];
  const payloads = (Array.isArray(base.body.payloads) ? base.body.payloads : []).filter(isRecord) as unknown as WritebackPayload[];
  const firstMerchant = payloads.findIndex((p) => p.connector === "merchant_center");
  const merchantGroup: WritebackPayload = { connector: "merchant_center", transport: "http", method: "POST", url: null, content_type: "application/json", body: "", dry_run: "", needs: "oauth_token", carries: {} } as unknown as WritebackPayload;
  // The catalog item goes where the preview's first Merchant Center change was; the per-product requests fold into it.
  const ordered = mc && record.products.length && firstMerchant >= 0 ? [...payloads.slice(0, firstMerchant), merchantGroup, ...payloads.slice(firstMerchant).filter((p) => !(p.connector === "merchant_center" && p.transport === "http"))] : payloads;
  for (const p of ordered) {
    if (p === merchantGroup && mc) {
      const inputs = merchantProductInputs(record, mc, iso(s.now()));
      const url = merchantInsertUrl(mc);
      const shown = url ?? `https://merchantapi.googleapis.com/products/v1/accounts/${encodeURIComponent(mc.merchantId)}/productInputs:insert`;
      const body = JSON.stringify({ productInputs: inputs.map((i) => i.body) }, null, 2);
      const item = { connector: "merchant_center", transport: "http" as const, url: shown, body };
      out.push({
        item_id: await itemId(item),
        ...item,
        target: `accounts/${mc.merchantId}`,
        method: "POST",
        content_type: "application/json",
        dry_run: `Would insert ${inputs.length} product${inputs.length === 1 ? "" : "s"} into Merchant Center account ${mc.merchantId} through the Merchant API (productInputs.insert${mc.dataSource ? `, data source ${mc.dataSource}` : ""}), each with the signed title, link, price, stock and GTIN. Needs your Google connection with Merchant Center access.`,
        needs: "oauth_token",
        carries: Object.fromEntries(inputs.map((i) => [i.offerId, i.carries])),
        ready: Boolean(url),
        ...(url ? {} : { blocked_by: "Choose the Merchant Center data source for this account under Company settings, Surfaces." }),
        request: { method: "POST", url: shown, body, batch: inputs.map((i) => JSON.stringify(i.body)), image_links: inputs.flatMap((i) => i.image_links) },
      });
      continue;
    }
    const item = { connector: p.connector, transport: p.transport, url: p.url, body: p.body };
    const http = p.transport === "http" && (p.method === "POST" || p.method === "PATCH") && p.url;
    out.push({
      item_id: await itemId(item),
      ...item,
      target: p.connector === "business_profile" ? (config.writeback?.business_profile_location ?? "") : (p.url ?? p.connector),
      method: p.method,
      content_type: p.content_type,
      dry_run: p.dry_run,
      needs: p.needs,
      carries: p.carries,
      ready: Boolean(http),
      ...(http ? {} : { blocked_by: "This change is a file: upload it or publish it on your site. Only changes sent to Google go through write-back." }),
      ...(http ? { request: { method: p.method as "POST" | "PATCH", url: p.url!, body: p.body, image_links: [] } } : {}),
    });
  }
  // QA-14: a change the Google connection was not granted for is not sendable, and says why, before anyone presses Send.
  const google = await s.store.getGoogle(trooth_id);
  if (google) {
    for (const p of out) {
      if (!p.ready) continue;
      if (p.connector === "merchant_center" && !google.products.includes("merchant")) Object.assign(p, { ready: false, blocked_by: NO_MERCHANT });
      if (p.connector === "business_profile" && !google.products.includes("business")) Object.assign(p, { ready: false, blocked_by: NO_BUSINESS });
    }
  }
  return out;
}

const NO_MERCHANT = "Google is connected without Merchant Center access. Connect Google again and allow Merchant Center.";
const NO_BUSINESS = "Google is connected without Business Profile access. Connect Google again and allow Business Profile.";

/** GET /os/semanto/{id}/writeback: the preview, every payload with its item_id. */
export async function writebackPreview(s: OsService, ws: WorkspaceAuth, trooth_id: string): Promise<WorkspaceResult> {
  const base = await s.p.read("writeback", ws, trooth_id, {});
  if (base.problem || !isRecord(base.body)) return base;
  const items = (await proposedItems(s, trooth_id)) ?? [];
  return ok(200, { ...base.body, payloads: items.map(({ request: _r, ready, blocked_by, ...rest }) => ({ ...rest, sendable: ready, ...(blocked_by ? { blocked_by } : {}) })) });
}

function itemView(i: WritebackItem) {
  return { item_id: i.item_id, connector: i.connector, target: i.target, dry_run: i.summary, state: i.state, attempts: i.attempts, last_error: i.last_error, sent_at: i.sent_at };
}

/** POST /os/semanto/{id}/writeback/send. */
export async function sendWriteback(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("send changes to Google");
  if (body.confirm !== true) return problem("invalid_request", 'Send { "confirm": true } with the items: this changes what Google shows.');
  const key = str(body.idempotency_key);
  if (!key || !IDEMPOTENCY_RE.test(key)) return problem("invalid_request", "idempotency_key is 8 to 200 letters, digits or . _ : - (a new random value for each send; the same value answers the same run).");
  // item_ids left out: every change the preview can send now (the "select all" of a bulk send); confirm is still required.
  const all = body.item_ids === undefined;
  const given = Array.isArray(body.item_ids) ? body.item_ids : null;
  if (!all && (!given || given.length === 0 || given.length > 500 || given.some((x) => typeof x !== "string") || new Set(given).size !== given.length)) return problem("invalid_request", "item_ids is a list of 1 to 500 different item ids from the preview, or leave it out to send every change the preview can send.");
  const existing = await s.store.writebackRunByKey(trooth_id, key);
  if (existing) return sameRunOrMismatch(s, trooth_id, existing.run_id, all ? null : (given as string[]));
  const google = await s.store.getGoogle(trooth_id);
  if (!google) return problem("conflict", "Connect Google first, under Connections. Nothing was sent.");
  if (google.state === "needs_reconnect") return problem("conflict", "Google needs you to connect again before anything is sent. Press Reconnect under Connections.");
  const proposed = await proposedItems(s, trooth_id);
  if (!proposed) return problem("conflict", "Write-back is built from the signed record. Sign a version first.");
  const ids = all ? proposed.filter((p) => p.ready && p.request).map((p) => p.item_id).slice(0, 500) : (given as string[]);
  if (ids.length === 0) return problem("conflict", "The preview has no change that can be sent now. Open it to see what each change needs first.");
  const chosen: ProposedItem[] = [];
  for (const id of ids) {
    const p = proposed.find((x) => x.item_id === id);
    if (!p) return problem("conflict", `Item ${id} is not a change write-back proposes now. Open the preview again and send the items it lists.`);
    if (!p.ready || !p.request) return problem("conflict", `Item ${id} cannot be sent: ${p.blocked_by}`);
    if (p.connector === "merchant_center" && !google.products.includes("merchant")) return problem("conflict", NO_MERCHANT);
    if (p.connector === "business_profile" && !google.products.includes("business")) return problem("conflict", NO_BUSINESS);
    chosen.push(p);
  }
  const now = s.now();
  const run_id = randomId("wbr", (n) => s.random(n));
  const items: WritebackItem[] = chosen.map((p) => ({ run_id, item_id: p.item_id, trooth_id, connector: p.connector as WritebackConnectorName, target: p.target, summary: p.dry_run, request: p.request!, state: "queued", attempts: 0, last_error: null, sent_at: null, updated_at: iso(now) }));
  const created = await s.store.createWritebackRun({ run_id, trooth_id, idempotency_key: key, created_by: ws.name, created_at: iso(now) }, items); // who sent it, as Recent changes names them (QA-19: the raw user id was shown)
  if (!created.created) return sameRunOrMismatch(s, trooth_id, created.run.run_id, all ? null : ids);
  await audit(s.store, { trooth_id, ws, action: "writeback.send", target: run_id, after: { run_id, item_ids: items.map((i) => i.item_id) }, ctx, at: now });
  await dispatch(s, trooth_id, run_id, items.map((i) => i.item_id));
  return ok(202, { object: "semanto.writeback_run", trooth_id, run_id, items: (await s.store.writebackItems(run_id)).map((i) => ({ item_id: i.item_id, state: i.state })) });
}

/**
 * The run an idempotency key already holds. The same key with other items is refused, as Stripe refuses an
 * idempotency key reused with other parameters, so a key copied by mistake never hides a send that did not happen.
 */
async function sameRunOrMismatch(s: OsService, trooth_id: string, run_id: string, ids: string[] | null): Promise<WorkspaceResult> {
  if (ids) {
    const held = (await s.store.writebackItems(run_id)).map((i) => i.item_id).sort();
    const asked = [...ids].sort();
    if (held.length !== asked.length || held.some((x, i) => x !== asked[i])) {
      return problem("conflict", `This idempotency_key was already used for run ${run_id} with other items. Nothing new was sent. Send these items with a new idempotency_key.`);
    }
  }
  return runDetail(s, trooth_id, run_id, 200);
}

/** The hosts write-back sends to with the Google token: the Merchant API and the Business Profile API, nothing else. */
export const WRITEBACK_HOSTS = ["merchantapi.googleapis.com", "mybusinessbusinessinformation.googleapis.com"] as const;
const isWritebackHost = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (WRITEBACK_HOSTS as readonly string[]).includes(u.host);
  } catch {
    return false;
  }
};

/** One queue message per item; without a queue (development) each is sent at once, once. */
async function dispatch(s: OsService, trooth_id: string, run_id: string, item_ids: string[]): Promise<void> {
  for (const item_id of item_ids) {
    if (s.d.enqueue) await s.d.enqueue({ kind: "writeback", trooth_id, run_id, item_id });
    else {
      try {
        await processWriteback(s, { kind: "writeback", trooth_id, run_id, item_id }, QUEUE_ATTEMPTS);
      } catch {
        // Without a queue there is no later attempt; the item keeps its state and its last error.
      }
    }
  }
}

/** Google's error message, in plain words. */
function googleMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; error_description?: unknown };
    if (j.error && typeof j.error === "object" && typeof j.error.message === "string") return j.error.message;
    if (typeof j.error_description === "string") return j.error_description;
  } catch {
    return body.slice(0, 300) || "no message";
  }
  return "no message";
}

/** The queue consumer for kind "writeback". Throws RetryLater on 429 or 5xx while attempts remain. */
export async function processWriteback(s: OsService, m: WritebackMessage, attempts: number): Promise<void> {
  const item = await s.store.getWritebackItem(m.run_id, m.item_id);
  if (!item || item.trooth_id !== m.trooth_id || item.state === "sent" || item.state === "failed") return;
  const at = () => iso(s.now());
  const tries = item.attempts + 1;
  await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "sending", attempts: tries }, at());
  const retryOrFail = async (error: string): Promise<void> => {
    if (attempts < QUEUE_ATTEMPTS) {
      await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "retrying", last_error: error }, at());
      throw new RetryLater(backoffFor(attempts), error);
    }
    await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "failed", last_error: `${error} Trooth tried ${QUEUE_ATTEMPTS} times.` }, at());
  };
  // The Google token goes only to Google's own write APIs, whatever URL a stored item holds.
  if (!isWritebackHost(item.request.url)) {
    await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "failed", last_error: "This change is not addressed to the Merchant API or the Business Profile API, so Trooth did not send it with your Google connection." }, at());
    return;
  }
  const token = await googleAccessToken(s, m.trooth_id);
  if (!token.ok) {
    if (token.reason === "upstream") return retryOrFail(token.detail);
    await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "failed", last_error: `needs_reconnect: ${token.detail}` }, at());
    return;
  }
  const bodies = item.request.batch ?? [item.request.body];
  let sent = 0;
  for (const body of bodies) {
    let res;
    try {
      res = await s.d.http(item.request.url, { method: item.request.method, headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", accept: "application/json" }, body });
    } catch {
      return retryOrFail("Google did not answer.");
    }
    if (res.status >= 200 && res.status < 300) {
      sent++;
      continue;
    }
    const which = bodies.length > 1 ? ` for offer ${offerIdOf(body)} (${sent} of ${bodies.length} were sent before it)` : "";
    // A 401 means the access token this isolate kept was revoked or expired early: drop it and try again with a fresh one.
    if (res.status === 401) {
      s.googleTokens.delete(m.trooth_id);
      return retryOrFail(`Google did not accept the access token (401)${which}.`);
    }
    if (res.status === 429 || res.status >= 500) return retryOrFail(`Google was busy (${res.status})${which}: ${googleMessage(res.body)}`);
    await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "failed", last_error: `Google refused this change (${res.status})${which}: ${googleMessage(res.body)}` }, at());
    return;
  }
  await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "sent", last_error: null, sent_at: at() }, at());
  for (const link of item.request.image_links) await queueCredential(s, { trooth_id: m.trooth_id, asset_url: link, source: "writeback" });
}

function offerIdOf(body: string): string {
  try {
    return String((JSON.parse(body) as { offerId?: unknown }).offerId ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** The last failed attempt of a writeback message that threw something other than RetryLater. */
export async function failWriteback(s: OsService, m: WritebackMessage, e: unknown): Promise<void> {
  const item = await s.store.getWritebackItem(m.run_id, m.item_id);
  if (!item || item.state === "sent" || item.state === "failed") return;
  await s.store.updateWritebackItem(m.run_id, m.item_id, { state: "failed", last_error: e instanceof RetryLater ? `${e.message} Trooth tried ${QUEUE_ATTEMPTS} times.` : "The send did not finish inside Trooth." }, iso(s.now()));
}

/** How many items of a run are in each state, so the history shows "3 sent, 1 failed" without counting rows. */
function countsOf(items: WritebackItem[]): Record<WritebackItem["state"], number> {
  const c: Record<WritebackItem["state"], number> = { queued: 0, sending: 0, retrying: 0, sent: 0, failed: 0 };
  for (const i of items) c[i.state] += 1;
  return c;
}

async function runDetail(s: OsService, trooth_id: string, run_id: string, status = 200): Promise<WorkspaceResult> {
  const run = await s.store.getWritebackRun(run_id);
  if (!run || run.trooth_id !== trooth_id) return problem("conflict", `There is no write-back run ${run_id} for this company.`);
  const items = await s.store.writebackItems(run_id);
  return ok(status, { object: "semanto.writeback_run", trooth_id, run_id, created_at: run.created_at, created_by: run.created_by, counts: countsOf(items), items: items.map(itemView) });
}

/** GET /os/semanto/{id}/writeback/runs?cursor=: newest first, 20 a page. */
export async function listRuns(s: OsService, trooth_id: string, q: Record<string, string>): Promise<WorkspaceResult> {
  const offset = decodeCursor(q.cursor);
  if (offset === null) return problem("invalid_request", "cursor is not one this server gave. Start again without a cursor.");
  const page = 20;
  const runs = (await s.store.listWritebackRuns(trooth_id, offset + page + 1)).slice(offset);
  const out = [];
  for (const r of runs.slice(0, page)) {
    const items = await s.store.writebackItems(r.run_id);
    out.push({ run_id: r.run_id, created_at: r.created_at, created_by: r.created_by, counts: countsOf(items), items: items.map((i) => ({ item_id: i.item_id, connector: i.connector, state: i.state })) });
  }
  return ok(200, { object: "semanto.writeback_runs", trooth_id, runs: out, next_cursor: runs.length > page ? encodeCursor(offset + page) : null });
}

/** GET /os/semanto/{id}/writeback/runs/{run_id}. */
export function getRun(s: OsService, trooth_id: string, run_id: string): Promise<WorkspaceResult> {
  return runDetail(s, trooth_id, run_id);
}

/** POST /os/semanto/{id}/writeback/runs/{run_id}/retry with { item_ids }: failed items only. */
export async function retryRun(s: OsService, ws: WorkspaceAuth, trooth_id: string, run_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("send changes to Google");
  const run = await s.store.getWritebackRun(run_id);
  if (!run || run.trooth_id !== trooth_id) return problem("conflict", `There is no write-back run ${run_id} for this company.`);
  const items = await s.store.writebackItems(run_id);
  // item_ids left out: every failed item of the run (the "retry all failed" of a send history).
  const all = body.item_ids === undefined;
  const ids = all ? items.filter((i) => i.state === "failed").map((i) => i.item_id) : Array.isArray(body.item_ids) ? body.item_ids : null;
  if (!ids || (!all && ids.length === 0) || ids.some((x) => typeof x !== "string") || new Set(ids).size !== ids.length) return problem("invalid_request", "item_ids is a list of the failed items to send again, or leave it out to send every failed item again.");
  if (ids.length === 0) return problem("conflict", `Run ${run_id} has no failed item to send again.`);
  for (const id of ids as string[]) {
    const i = items.find((x) => x.item_id === id);
    if (!i) return problem("conflict", `Item ${id} is not in run ${run_id}.`);
    if (i.state !== "failed") return problem("conflict", `Item ${id} is ${i.state}; only failed items are sent again.`);
  }
  const google = await s.store.getGoogle(trooth_id);
  if (!google || google.state !== "connected") return problem("conflict", "Connect Google again under Connections before sending again.");
  const now = s.now();
  // Each failed item is taken back to queued in one conditional write: of two retries at once (a double click), one
  // queues it and the other leaves it, so an item is never sent twice by a retry.
  const taken: string[] = [];
  for (const id of ids as string[]) if (await s.store.requeueWritebackItem(run_id, id, iso(now))) taken.push(id);
  if (taken.length) {
    await audit(s.store, { trooth_id, ws, action: "writeback.retry", target: run_id, after: { run_id, item_ids: taken }, ctx, at: now });
    await dispatch(s, trooth_id, run_id, taken);
  }
  return runDetail(s, trooth_id, run_id, 202);
}
