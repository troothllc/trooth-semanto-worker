// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Recall events into worker-f's company changes feed, the sender side
// (contract section 5). When a recall is stored or changed through the
// commerce store, the Semanto Worker posts it to worker-f through the
// TROOTH_OS service binding at POST /internal/semanto/recall-events, signed
// the way Stripe signs webhooks: a header
//
//   Trooth-Event-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">
//
// with the shared secret SEMANTO_EVENTS_SECRET (set on both Workers) and a
// five-minute tolerance on the receiving side. event_id is the SHA-256 (64
// lowercase hex) of (trooth_id, recall_id, content hash), so the same recall
// sent twice is one event: this side stores it once and worker-f answers a
// duplicate with { duplicate: true }. The body carries the company's proven
// domain and its trooth.co workspace (os_company_id), and the product record
// the recall names; an event worker-f could not file (no workspace, no
// proven domain, no product record) is kept as failed with the reason, and is
// sent when the same recall is stored again once it can be filed. A 429
// or 5xx is retried through the queue (kind "recall_event") after 30, 120 and
// 600 seconds; another 4xx is a fault in the event and is not retried.

import { canonicalize } from "../core/canonical";
import { digest, sha256Hex } from "../core/hash";
import { utf8 } from "../core/encoding";
import type { CommerceStore } from "../commerce/ports";
import { signRecall, validateRecall, verifyRecall, type RecallNotice, type RecallNoticeInput, type SignedRecall } from "../commerce/recalls";
import { checkPurposeAssertion } from "../pipeline-passkeys";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import type { RecallEventMessage } from "../env";
import { ADMIN_ONLY, audit, backoffFor, iso, isRecord, mayAdminister, ok, problem, QUEUE_ATTEMPTS, RetryLater, type RequestContext } from "./common";
import type { OsService } from "./service";
import { isDomainProven } from "../serve/ports";

/** Through the TROOTH_OS binding the host must be "os": worker-f answers 404 to /internal on any other host. */
export const RECALL_EVENTS_URL = "https://os/internal/semanto/recall-events";
export const EVENT_SIGNATURE_HEADER = "Trooth-Event-Signature";
export const EVENT_TOLERANCE_SECONDS = 300;

const REMEDY: Record<RecallNotice["action"], string> = { stop_sale: "Stop selling it.", stop_use: "Stop using it.", return: "Return it.", repair: "Get it repaired." };

export interface RecallEventBody {
  event_id: string;
  trooth_id: string;
  os_company_id: string;
  domain: string;
  recall: {
    recall_id: string;
    product_record_id: string;
    gtin?: string;
    title: string;
    remedy?: string;
    published_at: string;
    source_url?: string;
    provenance: "public_record" | "declared";
  };
  emitted_at: string;
}

/** sha256(trooth_id, recall_id, content hash) as 64 lowercase hex: the same recall is the same event. */
export async function recallEventId(trooth_id: string, notice: RecallNotice): Promise<string> {
  return sha256Hex(utf8(canonicalize([trooth_id, notice.id, await digest(canonicalize(notice))])));
}

/** HMAC-SHA256 hex of "t.body" under the secret. */
export async function eventSignature(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`) as BufferSource));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The header value: t=<unix seconds>,v1=<hex>. */
export async function signEvent(secret: string, body: string, now: Date): Promise<string> {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${await eventSignature(secret, t, body)}`;
}

/** The receiving side's check, for tests and for worker-f's reference: the header parses, the HMAC matches, and t is within the tolerance. */
export async function checkEventSignature(secret: string, header: string | null, body: string, now: Date): Promise<boolean> {
  const m = header ? /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim()) : null;
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > EVENT_TOLERANCE_SECONDS) return false;
  const want = await eventSignature(secret, t, body);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0;
}

/** The event body for a stored recall, or the reason worker-f could not file it. */
export async function recallEventBody(s: OsService, trooth_id: string, signed: SignedRecall, records: { record: { id: string; sku: string; gtin?: string } }[]): Promise<{ ok: true; body: RecallEventBody } | { ok: false; event_id: string; reason: string }> {
  const n = signed.notice;
  const event_id = await recallEventId(trooth_id, n);
  const company = await s.company(trooth_id);
  if (!company?.os_company_id) return { ok: false, event_id, reason: "This company is not linked to a trooth.co workspace, so the changes feed has no place for the recall." };
  if (!isDomainProven(company)) return { ok: false, event_id, reason: "This company has not proven its domain, so the recall is not published to the changes feed." };
  const match = records.find((r) => (n.skus ?? []).includes(r.record.sku) || (r.record.gtin !== undefined && (n.gtins ?? []).includes(r.record.gtin)));
  if (!match) return { ok: false, event_id, reason: "The recall names no product record on file (by sku or GTIN), and the changes feed files a recall under its product record." };
  const firstSentence = n.statement.split(/(?<=[.!?])\s/)[0] ?? n.statement;
  const gtin = n.gtins?.[0] ?? match.record.gtin;
  return {
    ok: true,
    body: {
      event_id,
      trooth_id,
      os_company_id: company.os_company_id,
      domain: company.domain,
      recall: {
        recall_id: n.id,
        product_record_id: match.record.id,
        ...(gtin && /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin) ? { gtin } : {}),
        title: firstSentence.trim().slice(0, 300),
        remedy: REMEDY[n.action],
        published_at: n.issued_at,
        source_url: n.authority?.url ?? n.url,
        provenance: n.authority ? "public_record" : "declared",
      },
      emitted_at: iso(s.now()),
    },
  };
}

/** One signed POST to worker-f. ok on 2xx (a duplicate answers 200 too); retry on 429, 5xx or no answer; a 4xx otherwise is final. */
async function deliver(s: OsService, body: string): Promise<{ ok: boolean; retry: boolean; detail: string }> {
  if (!s.d.troothOs || !s.d.eventsSecret) return { ok: false, retry: false, detail: "This deployment cannot send recall events yet (TROOTH_OS binding and SEMANTO_EVENTS_SECRET)." };
  try {
    const res = await s.d.troothOs.fetch(RECALL_EVENTS_URL, { method: "POST", headers: { "content-type": "application/json", [EVENT_SIGNATURE_HEADER]: await signEvent(s.d.eventsSecret, body, s.now()) }, body });
    if (res.status >= 200 && res.status < 300) return { ok: true, retry: false, detail: "" };
    return { ok: false, retry: res.status === 429 || res.status >= 500, detail: `worker-f answered ${res.status}.` };
  } catch {
    return { ok: false, retry: true, detail: "worker-f did not answer." };
  }
}

/** A recall was stored or changed: store the event once, send it now, and queue a retry if the send failed for a reason that can pass. */
export async function emitRecall(s: OsService, trooth_id: string, signed: SignedRecall, records: { record: { id: string; sku: string; gtin?: string } }[]): Promise<{ event_id: string; state: "sent" | "queued" | "failed" | "duplicate" }> {
  const built = await recallEventBody(s, trooth_id, signed, records);
  const at = iso(s.now());
  if (!built.ok) {
    const fresh = await s.store.putRecallEvent({ event_id: built.event_id, trooth_id, recall_id: signed.notice.id, body: "", state: "failed", attempts: 0, last_error: built.reason, created_at: at, sent_at: null });
    return { event_id: built.event_id, state: fresh ? "failed" : "duplicate" };
  }
  const event = built.body;
  const body = JSON.stringify(event);
  // A recall kept as failed (it could not be built then: no product record, no workspace link, no proven domain; or its
  // send failed for good) is sent again when the same recall is stored again: its event id is the same, so the stored
  // row takes the body instead of answering a duplicate, and worker-f files it once whatever happened before.
  if (!(await s.store.putRecallEvent({ event_id: event.event_id, trooth_id, recall_id: signed.notice.id, body, state: "queued", attempts: 0, last_error: null, created_at: at, sent_at: null })) && !(await s.store.reviveRecallEvent(event.event_id, body))) return { event_id: event.event_id, state: "duplicate" };
  const r = await deliver(s, body);
  if (r.ok) {
    await s.store.updateRecallEvent(event.event_id, { state: "sent", attempts: 1, sent_at: iso(s.now()) });
    return { event_id: event.event_id, state: "sent" };
  }
  if (r.retry && s.d.enqueue) {
    await s.store.updateRecallEvent(event.event_id, { attempts: 1, last_error: r.detail });
    await s.d.enqueue({ kind: "recall_event", trooth_id, event_id: event.event_id });
    return { event_id: event.event_id, state: "queued" };
  }
  await s.store.updateRecallEvent(event.event_id, { state: "failed", attempts: 1, last_error: r.detail });
  return { event_id: event.event_id, state: "failed" };
}

/** The queue consumer for kind "recall_event": the stored body, signed again with a fresh t. */
export async function processRecallEvent(s: OsService, m: RecallEventMessage, attempts: number): Promise<void> {
  const e = await s.store.getRecallEvent(m.event_id);
  if (!e || e.state === "sent" || e.state === "failed" || !e.body) return;
  const r = await deliver(s, e.body);
  if (r.ok) {
    await s.store.updateRecallEvent(e.event_id, { state: "sent", attempts: e.attempts + 1, sent_at: iso(s.now()), last_error: null });
    return;
  }
  if (r.retry && attempts < QUEUE_ATTEMPTS) {
    await s.store.updateRecallEvent(e.event_id, { attempts: e.attempts + 1, last_error: r.detail });
    throw new RetryLater(backoffFor(attempts), r.detail);
  }
  await s.store.updateRecallEvent(e.event_id, { state: "failed", attempts: e.attempts + 1, last_error: r.detail });
}

/**
 * A commerce store whose putRecall also emits the recall event, so every
 * place a recall is stored or changed sends it. The emitter is looked up on
 * each call, so it can be wired after the store is made.
 */
export function withRecallEvents(inner: CommerceStore, emitter: () => OsService | null): CommerceStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "putRecall") {
        return async (trooth_id: string, signed: SignedRecall): Promise<void> => {
          await target.putRecall(trooth_id, signed);
          const s = emitter();
          if (!s) return;
          try {
            await emitRecall(s, trooth_id, signed, await target.records(trooth_id));
          } catch (e) {
            // The recall is stored; the event is not. The exception is logged with a request id, never thrown into the store's caller.
            s.logError(s.p.requestId(), "recall event", e);
          }
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------- the workspace routes: store a recall

/** What a recall answer shows of its event: whether it reached worker-f's changes feed, and why not when it did not. */
async function eventView(s: OsService, trooth_id: string, notice: RecallNotice) {
  const e = await s.store.getRecallEvent(await recallEventId(trooth_id, notice));
  return e ? { event_id: e.event_id, state: e.state, attempts: e.attempts, last_error: e.last_error, sent_at: e.sent_at } : null;
}

function recallView(r: SignedRecall) {
  const n = r.notice;
  return { recall_id: n.id, issued_at: n.issued_at, action: n.action, statement: n.statement, url: n.url, ...(n.skus ? { skus: n.skus } : {}), ...(n.gtins ? { gtins: n.gtins } : {}), ...(n.lots ? { lots: n.lots } : {}), ...(n.authority ? { authority: n.authority } : {}), ...(n.closed_at ? { closed_at: n.closed_at } : {}), kid: r.kid };
}

/** The notice a hosted company sends, checked with the same rules the signature step uses; plain sentences for each problem. */
function noticeIssues(input: unknown, now: Date): string[] {
  if (!isRecord(input)) return ["notice is the recall notice: { skus or gtins, issued_at, action, statement, url, authority?, lots?, closed_at? }."];
  const issues = validateRecall(input).map((i) => `${i.path || "notice"}: ${i.message}.`);
  if (typeof input.issued_at === "string" && Date.parse(input.issued_at) > now.getTime() + 5 * 60_000) issues.push("issued_at: not in the future.");
  return issues;
}

/** POST /os/semanto/{id}/recalls/options with { notice }: the passkey request bound to this person and this exact notice (custody hosted). */
export async function recallOptions(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("publish a recall");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  if (company.custody !== "hosted") return problem("conflict", "Your company holds its own signing key. Sign the recall notice yourself and send it as jws.");
  const issues = noticeIssues(body.notice, s.now());
  if (issues.length) return { status: 0, problem: { code: "invalid_request", detail: issues.join(" "), extensions: { issues } } };
  return s.p.handle("sign/options", ws, trooth_id, { purpose: "recall", notice: body.notice });
}

/**
 * POST /os/semanto/{id}/recalls: store a signed recall notice, which also sends it to worker-f's changes feed
 * (withRecallEvents). Custody customer: { jws }, the notice signed with the company's key (typ JWS_TYPES.recall).
 * Custody hosted: { notice, assertion }, the passkey answer bound to that exact notice; the hosted key signs it after
 * the check, as seller lists and versions are signed. The answer says whether the recall reached the feed.
 */
export async function submitRecall(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("publish a recall");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first. Nothing is signed or served before the proof.`);
  const now = s.now();
  let signed: SignedRecall;
  if (typeof body.jws === "string") {
    const keys = (await s.p.d.store.keys(trooth_id)).filter((k) => !k.next).map((k) => k.public_jwk);
    const v = await verifyRecall(body.jws, (kid) => keys.find((k) => k.kid === kid) ?? null, { at: now });
    if (!v.ok) {
      const hint = v.reason === "key_not_yet_valid" ? " The key was not on file at the JWS iat: sign with iat set to the time you sign, not the recall's issued_at." : "";
      return { status: 0, problem: { code: "signature_invalid", detail: `The recall notice did not check out (${v.reason}${v.issues ? `: ${v.issues.map((i) => `${i.path} ${i.message}`).join("; ")}` : ""}).${hint} Nothing was stored.` } };
    }
    signed = { notice: v.notice, jws: body.jws, kid: v.kid };
  } else if (body.notice !== undefined) {
    if (company.custody !== "hosted") return problem("conflict", "Your company holds its own signing key. Sign the recall notice yourself and send it as jws.");
    const issues = noticeIssues(body.notice, now);
    if (issues.length) return { status: 0, problem: { code: "invalid_request", detail: issues.join(" "), extensions: { issues } } };
    const checked = await checkPurposeAssertion(s.p, ws, trooth_id, "recall", canonicalize(body.notice), body);
    if (!checked.ok) return checked.result;
    const key = await s.p.d.keys.getCompanySigningKey(trooth_id);
    if (!key) return problem("conflict", "There is no hosted signing key to sign with yet. Sign a version first.");
    signed = await signRecall(body.notice as RecallNoticeInput, key, { iat: now });
  } else return problem("invalid_request", 'Send { "jws": "<compact JWS>" } when you hold your key, or { "notice": <notice>, "assertion": <passkey answer> } when Trooth holds it.');
  const existing = (await s.p.d.commerce.recalls(trooth_id)).find((r) => r.notice.id === signed.notice.id);
  await s.p.d.commerce.putRecall(trooth_id, signed);
  if (!existing) await audit(s.store, { trooth_id, ws, action: "recalls.publish", target: signed.notice.id, after: recallView(signed), ctx, at: now });
  return ok(existing ? 200 : 201, { object: "semanto.recall", trooth_id, ...recallView(signed), jws: signed.jws, event: await eventView(s, trooth_id, signed.notice) });
}

/** GET /os/semanto/{id}/recalls: every stored recall, newest first, with whether it reached worker-f's changes feed. */
export async function listRecalls(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  const all = (await s.p.d.commerce.recalls(trooth_id)).sort((a, b) => b.notice.issued_at.localeCompare(a.notice.issued_at) || a.notice.id.localeCompare(b.notice.id));
  const recalls = [];
  for (const r of all) recalls.push({ ...recallView(r), event: await eventView(s, trooth_id, r.notice) });
  return ok(200, { object: "semanto.recalls", trooth_id, recalls });
}
