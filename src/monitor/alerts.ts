// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Plain-language alerts for a small business owner, from mismatches and
// indexability results. Short sentences. Both values, both sources, one
// question or one next step. No jargon, no verdict, no number about the
// company. Alerts are deduplicated against open alerts (same kind and key),
// capped per company per day, and sent as one email through a Resend-shaped
// port (api.resend.com POST /emails) in plain text and a minimal HTML in the
// brand colors: Ink #202124, Paper #F7F8F8, blue #1A73E8 on the one action
// link. The dashboard list shape is here too.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId } from "../core/ids";
import { reasonInWords } from "./indexability";
import { displayValue, familyOf } from "./normalize";
import type { EmailMessage, EmailPort } from "./ports";
import type { Alert, AlertKind, AlertRow, IndexabilityReport, Mismatch, Severity, SignedRecord, Surface } from "./types";

export const DEFAULT_DAILY_CAP = 5;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "20 October" from an ISO instant. */
export function dayWords(iso: string | null | undefined): string {
  if (!iso) return "an unknown date";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "an unknown date";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function surfaceWords(surface: Surface): string {
  switch (surface) {
    case "merchant_center":
      return "Google's shopping listing";
    case "business_profile":
      return "Google's business listing";
    case "live_page":
      return "Your website";
    case "ucp":
      return "Your UCP catalog";
    case "acp":
      return "Your ACP feed";
    case "semanto":
      return "Your signed record";
  }
}

/** The field in words: "phone", "Monday hours", "the price of Acme Kettle". */
export function fieldWords(key: string, record?: SignedRecord | null): string {
  if (key === "contact.phone") return "phone";
  if (key === "contact.address") return "address";
  if (key === "contact.website") return "website address";
  if (key === "identity.legal_name") return "business name";
  const h = /^hours\.([a-z]+)$/.exec(key);
  if (h && h[1]) return `${h[1].charAt(0).toUpperCase()}${h[1].slice(1)} hours`;
  const p = /^product\.([^.]+)(?:\.([a-z_]+))?$/.exec(key);
  if (p && p[1]) {
    const name = productName(p[1], record);
    switch (p[2]) {
      case "price":
        return `the price of ${name}`;
      case "availability":
        return `the stock status of ${name}`;
      case "gtin":
        return `the barcode number (GTIN) of ${name}`;
      case "name":
        return `the name of ${name}`;
      case "consumer_notice":
        return `the consumer notice for ${name}`;
      case "url":
        return `the page address of ${name}`;
      case "brand":
        return `the brand of ${name}`;
      case undefined:
        return name;
      default:
        return `${p[2].replace(/_/g, " ")} for ${name}`;
    }
  }
  return key.replace(/[._]/g, " ");
}

/** "your phone", "your Monday hours", but "the price of Acme Kettle". */
export function fieldPhrase(key: string, record?: SignedRecord | null): string {
  const f = fieldWords(key, record);
  return key.startsWith("product.") ? f : `your ${f}`;
}

function productName(key: string, record?: SignedRecord | null): string {
  const p = record?.products.find((x) => x.sku === key || x.gtin === key || x.product_id === key);
  return p ? p.name : `product ${key}`;
}

function pageTitle(url: string, record?: SignedRecord | null): string {
  const page = record?.pages.find((p) => p.url === url || p.url.replace(/\/+$/, "") === url.replace(/\/+$/, ""));
  if (page && page.title) return `${page.title.replace(/\s*[|–-]\s*.*$/, "").trim()} page`;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path ? `${path.split("/").pop()} page` : "home page";
  } catch {
    return "page";
  }
}

// ------------------------------------------------------------ messages

export function messageForMismatch(m: Mismatch, record?: SignedRecord | null): { kind: AlertKind; message: string } | null {
  const where = surfaceWords(m.surface);
  const field = fieldPhrase(m.key, record);
  if (m.key === "page.jsonld") {
    return { kind: "missing_structured_data", message: `Your ${pageTitle(m.surface_url ?? "", record)} has no structured data block. Add the one Semanto generated so search engines can read your facts as data.` };
  }
  if (m.key === "page.content") {
    return { kind: "page_changed", message: `Your ${pageTitle(m.surface_url ?? "", record)} changed on ${dayWords(m.surface_observed_at)}. You signed it on ${dayWords(m.signed_witnessed_at)}. Sign the new version or keep the old one.` };
  }
  const signed = displayValue(m.key, m.signed_value);
  const seen = displayValue(m.key, m.surface_value);
  switch (m.kind) {
    case "differs":
      return { kind: "surface_mismatch", message: `${where} shows ${field} as ${seen}. Your signed record says ${signed}. Which one is right?` };
    case "stale":
      return { kind: "stale_surface", message: `${where} was last updated on ${dayWords(m.surface_observed_at)} and shows ${field} as ${seen}. You signed ${signed} on ${dayWords(m.signed_witnessed_at)}. Update ${where.replace(/^Your /, "your ")} to match.` };
    case "missing_on_surface":
      if (/^product\.[^.]+$/.test(m.key)) return { kind: "missing_on_surface", message: `${where} does not list ${field}. Your signed record has it. Add it there, or remove it from the record.` };
      if (m.surface === "live_page") return { kind: "missing_on_surface", message: `${where} no longer shows ${field} as ${signed}. Your signed record still says so. Update the page or the record.` };
      return { kind: "missing_on_surface", message: `${where} has no ${field}. Your signed record says ${signed}. Add it there, or remove it from the record.` };
    case "missing_in_record":
      if (/^product\.[^.]+$/.test(m.key)) return { kind: "missing_in_record", message: `${where} lists ${seenName(m)}. Your signed record does not have it. Add it to the record if it is right.` };
      return { kind: "missing_in_record", message: `${where} shows ${field} as ${seen}. Your signed record does not have it. Add it to the record if it is right.` };
  }
}

function seenName(m: Mismatch): string {
  const v = m.surface_value;
  if (typeof v === "string" && familyOf(m.key) !== "price") return `a product called ${v}`;
  return `a product (${m.key.replace(/^product\./, "")})`;
}

export function messagesForIndexability(report: IndexabilityReport, record?: SignedRecord | null): { kind: AlertKind; key: string; message: string; url: string; severity: Severity }[] {
  const out: { kind: AlertKind; key: string; message: string; url: string; severity: Severity }[] = [];
  for (const p of report.pages) {
    if (p.eligible) continue;
    const title = pageTitle(p.url, record);
    const first = p.reasons[0];
    if (!first || first === "not_fetched") continue;
    let message: string;
    if (first === "non_200") message = `Your ${title} did not load (it answered ${p.status ?? "nothing"}), so it cannot appear in AI answers.`;
    else if (first === "soft_404") message = `Your ${title} loads but looks like a not found page, so it may not appear in AI answers.`;
    else if (first === "canonical_elsewhere") message = `Your ${title} points search engines to a different address, so this address will not appear in AI answers.`;
    else message = `Your ${title} ${reasonInWords(first)}, so it cannot appear in AI answers.`;
    out.push({ kind: "not_indexable", key: p.url, message, url: p.url, severity: "visibility" });
  }
  return out;
}

// -------------------------------------------------------------- alerts

export interface AlertSource {
  mismatches: Mismatch[];
  indexability: IndexabilityReport;
  record?: SignedRecord | null;
}

export async function alertsFrom(trooth_id: string, source: AlertSource, created_at: string): Promise<Alert[]> {
  const out: Alert[] = [];
  const seenKeys = new Set<string>();
  for (const m of source.mismatches) {
    const built = messageForMismatch(m, source.record);
    if (!built) continue;
    const key = m.key === "page.jsonld" || m.key === "page.content" ? `${m.key}:${m.surface_url ?? ""}` : `${m.key}@${m.surface}`;
    const dedupe = `${built.kind}|${key}`;
    if (seenKeys.has(dedupe)) continue;
    seenKeys.add(dedupe);
    out.push(await makeAlert(trooth_id, built.kind, key, m.severity, built.message, { mismatch: m }, created_at));
  }
  for (const x of messagesForIndexability(source.indexability, source.record)) {
    const dedupe = `${x.kind}|${x.key}`;
    if (seenKeys.has(dedupe)) continue;
    seenKeys.add(dedupe);
    const page = source.indexability.pages.find((p) => p.url === x.url);
    out.push(await makeAlert(trooth_id, x.kind, x.key, x.severity, x.message, { indexability: page ?? null }, created_at));
  }
  return sortAlerts(out);
}

async function makeAlert(trooth_id: string, kind: AlertKind, key: string, severity: Severity, message: string, detail: Record<string, unknown>, created_at: string): Promise<Alert> {
  const id = semantoId("sma", await digest(canonicalize({ trooth_id, kind, key })));
  return { id, trooth_id, kind, key, severity, message, detail, created_at, sent_at: null, resolved_at: null };
}

const SEVERITY_ORDER: Record<Severity, number> = { trust: 0, visibility: 1, note: 2 };

export function sortAlerts(list: Alert[]): Alert[] {
  return list.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.key.localeCompare(b.key));
}

/** Fresh alerts that are not already open (same kind and key). */
export function dedupeAlerts(fresh: Alert[], open: Alert[]): { fresh: Alert[]; duplicates: Alert[] } {
  const openKeys = new Set(open.filter((a) => a.resolved_at === null).map((a) => `${a.kind}|${a.key}`));
  const out: Alert[] = [];
  const dup: Alert[] = [];
  for (const a of fresh) (openKeys.has(`${a.kind}|${a.key}`) ? dup : out).push(a);
  return { fresh: out, duplicates: dup };
}

/** Open alerts whose kind and key no longer appear: they are resolved at `at`. */
export function resolvedAlerts(open: Alert[], current: Alert[], at: string): Alert[] {
  const currentKeys = new Set(current.map((a) => `${a.kind}|${a.key}`));
  return open.filter((a) => a.resolved_at === null && !currentKeys.has(`${a.kind}|${a.key}`)).map((a) => Object.assign({}, a, { resolved_at: at }));
}

/** At most `cap` alerts sent per company per day; the rest are held (stored, not emailed). Trust first. */
export function applyDailyCap(fresh: Alert[], sentToday: number, cap = DEFAULT_DAILY_CAP): { send: Alert[]; held: Alert[] } {
  const room = Math.max(0, cap - sentToday);
  const sorted = sortAlerts(fresh);
  return { send: sorted.slice(0, room), held: sorted.slice(room) };
}

export function startOfDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

// --------------------------------------------------------------- email

const INK = "#202124";
const PAPER = "#F7F8F8";
const BLUE = "#1A73E8";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function emailSubject(alerts: Alert[], domain: string): string {
  const n = alerts.length;
  if (n === 1) return `One thing to check on ${domain}`;
  return `${n} things to check on ${domain}`;
}

export function emailText(alerts: Alert[], domain: string, actionUrl: string): string {
  const lines: string[] = [];
  lines.push(`We checked ${domain} against what Google and the other surfaces show.`);
  lines.push("");
  alerts.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.message}`);
    lines.push("");
  });
  lines.push(`Review and fix: ${actionUrl}`);
  lines.push("");
  lines.push("Semanto by Trooth reports what each surface says. It does not decide which one is right; you do.");
  return lines.join("\n");
}

export function emailHtml(alerts: Alert[], domain: string, actionUrl: string): string {
  const items = alerts.map((a) => `<li style="margin:0 0 12px 0;line-height:1.5">${escapeHtml(a.message)}</li>`).join("");
  return [
    `<!doctype html><html><body style="margin:0;padding:24px;background:${PAPER};color:${INK};font-family:'Open Sauce One',Helvetica,Arial,sans-serif;font-size:16px">`,
    `<div style="max-width:560px;margin:0 auto;background:#FFFFFF;padding:24px;border-radius:8px">`,
    `<p style="margin:0 0 16px 0">We checked <strong>${escapeHtml(domain)}</strong> against what Google and the other surfaces show.</p>`,
    `<ol style="padding-left:20px;margin:0 0 20px 0">${items}</ol>`,
    `<p style="margin:0 0 20px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:${BLUE};color:#FFFFFF;text-decoration:none;padding:10px 16px;border-radius:6px">Review and fix</a></p>`,
    `<p style="margin:0;font-size:13px;color:${INK}">Semanto by Trooth reports what each surface says. It does not decide which one is right; you do.</p>`,
    `</div></body></html>`,
  ].join("");
}

export function buildEmail(alerts: Alert[], opts: { from: string; to: string[]; domain: string; actionUrl: string }): EmailMessage {
  return { from: opts.from, to: opts.to, subject: emailSubject(alerts, opts.domain), text: emailText(alerts, opts.domain, opts.actionUrl), html: emailHtml(alerts, opts.domain, opts.actionUrl) };
}

export async function sendAlertEmail(port: EmailPort, alerts: Alert[], opts: { from: string; to: string[]; domain: string; actionUrl: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!alerts.length) return { ok: false, error: "nothing to send" };
  return port.send(buildEmail(alerts, opts));
}

// ----------------------------------------------------------- dashboard

export interface DashboardAlert {
  id: string;
  severity: Severity;
  kind: AlertKind;
  key: string;
  message: string;
  created_at: string;
  sent: boolean;
  resolved: boolean;
  surface: Surface | null;
  action: { label: string; url: string | null };
}

export function toDashboard(alerts: Alert[]): DashboardAlert[] {
  return sortAlerts(alerts).map((a) => {
    const m = a.detail.mismatch as Mismatch | undefined;
    const surface = m ? m.surface : a.kind === "not_indexable" ? "live_page" : null;
    const url = m ? m.surface_url ?? m.signed_evidence_url ?? null : a.kind === "not_indexable" ? a.key : null;
    const label = a.kind === "surface_mismatch" || a.kind === "stale_surface" ? "Pick the right value" : a.kind === "page_changed" ? "Sign the new version" : a.kind === "not_indexable" ? "Open the page" : a.kind === "missing_structured_data" ? "Add the block" : a.kind === "missing_in_record" ? "Add to the record" : "Add to the surface";
    return { id: a.id, severity: a.severity, kind: a.kind, key: a.key, message: a.message, created_at: a.created_at, sent: a.sent_at !== null, resolved: a.resolved_at !== null, surface, action: { label, url } };
  });
}

export function alertToRow(a: Alert): AlertRow {
  return { id: a.id, trooth_id: a.trooth_id, kind: a.kind, message: a.message, detail_json: JSON.stringify({ key: a.key, severity: a.severity, detail: a.detail }), created_at: a.created_at, sent_at: a.sent_at, resolved_at: a.resolved_at };
}

export function alertFromRow(r: AlertRow): Alert {
  const d = JSON.parse(r.detail_json) as { key: string; severity: Severity; detail: Record<string, unknown> };
  return { id: r.id, trooth_id: r.trooth_id, kind: r.kind as AlertKind, key: d.key, severity: d.severity, message: r.message, detail: d.detail, created_at: r.created_at, sent_at: r.sent_at, resolved_at: r.resolved_at };
}
