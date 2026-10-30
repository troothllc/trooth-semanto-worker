// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The monitor run: take the signed record and the surfaces the company has
// connected, read each one through the fetch port, compare, check
// indexability, store the run (semanto_monitor_runs), raise alerts
// (semanto_alerts, deduplicated and capped), and return a summary with counts
// by severity and what to fix in order of effect: trust first, then
// visibility, then notes. A surface the company has not connected is listed
// as absent and never counted as a mismatch; a surface that failed to read is
// listed as failed with the reason. This is the handler behind
// POST /os/semanto/{trooth_id}/monitor/run; the route itself is not here.

import { parity, type ParityResult } from "./parity";
import { alertsFrom, applyDailyCap, dedupeAlerts, resolvedAlerts, sendAlertEmail, startOfDay, surfaceWords, fieldWords, DEFAULT_DAILY_CAP } from "./alerts";
import { buildRun, compareAll, countBySeverity } from "./consistency";
import { indexabilityReport, type IndexabilityOptions } from "./indexability";
import type { MonitorPorts } from "./ports";
import { readAcp, readBusinessProfile, readLivePage, readMerchantCenter, readSemanto, readUcp, type MerchantCenterFormat } from "./surfaces";
import type { Alert, LivePageRead, Mismatch, MonitorRun, Severity, SignedRecord, Surface, SurfaceRead, SurfaceStatus } from "./types";

/** What the company has connected. Leave a surface out when it is not connected; the run says so. */
export interface AvailableSurfaces {
  merchant_center?: { url: string; format?: MerchantCenterFormat } | null;
  business_profile?: { url: string } | null;
  ucp?: { manifest_url: string; catalog_url?: string } | null;
  acp?: { url: string } | null;
  /** Read the signed pages live; default true. */
  live_pages?: boolean;
  /** Fetch robots.txt for the indexability check; default true. */
  robots?: boolean;
}

export interface RunInput {
  record: SignedRecord;
  surfaces: AvailableSurfaces;
  indexability?: IndexabilityOptions;
  /** Where alerts go; without it alerts are stored but not emailed. */
  email?: { from: string; to: string[]; actionUrl: string };
  dailyCap?: number;
  /** Cap on pages fetched live per run, so a large site does not stall the Worker. */
  maxPages?: number;
}

export interface Fix {
  order: number;
  severity: Severity;
  key: string;
  surface: Surface;
  kind: Mismatch["kind"];
  what_to_do: string;
}

export interface RunSummary {
  run_id: string;
  ran_at: string;
  counts: Record<Severity, number>;
  surfaces: SurfaceStatus[];
  fixes: Fix[];
  pages: { checked: number; eligible: number; not_eligible: number; jsonld_present: number };
  alerts: { raised: number; duplicates: number; held_by_cap: number; resolved: number; emailed: boolean; email_error: string | null };
  /** Signed facts found word for word on their live pages (src/monitor/parity.ts); null when live pages were not read. */
  parity: ParityResult | null;
}

export async function runMonitor(input: RunInput, ports: MonitorPorts): Promise<{ run: MonitorRun; summary: RunSummary; alerts: Alert[] }> {
  const now = ports.clock.now().toISOString();
  const record = input.record;
  const statuses: SurfaceStatus[] = [];
  const reads: SurfaceRead[] = [];

  const semanto = readSemanto(record, now, `https://api.trooth.co/public/semanto/${record.trooth_id}`);
  reads.push(semanto);
  statuses.push({ surface: "semanto", state: "read", url: semanto.url, note: semanto.notes.join("; "), facts: semanto.facts.length });

  const note = async (surface: Surface, cfg: unknown, absentWhy: string, read: () => Promise<SurfaceRead>) => {
    if (!cfg) {
      statuses.push({ surface, state: "absent", url: null, note: absentWhy, facts: 0 });
      return;
    }
    try {
      const r = await read();
      const failed = r.facts.length === 0 && r.notes.some((n) => /answered \d+|did not parse|fetch failed/.test(n));
      statuses.push({ surface, state: failed ? "failed" : "read", url: r.url, note: r.notes.join("; ") || "read", facts: r.facts.length });
      if (!failed) reads.push(r);
    } catch (e) {
      statuses.push({ surface, state: "failed", url: null, note: e instanceof Error ? e.message : "unknown error", facts: 0 });
    }
  };

  await note("merchant_center", input.surfaces.merchant_center, "Merchant Center is not connected", async () => readMerchantCenter(ports.fetch, { url: input.surfaces.merchant_center!.url, format: input.surfaces.merchant_center!.format, token: await tokenFor("merchant_center", input.surfaces.merchant_center!.url, ports) }, now));
  await note("business_profile", input.surfaces.business_profile, "Business Profile is not connected", async () => readBusinessProfile(ports.fetch, { url: input.surfaces.business_profile!.url, token: await tokenFor("business_profile", input.surfaces.business_profile!.url, ports) }, now));
  await note("ucp", input.surfaces.ucp, "no UCP manifest address given", () => readUcp(ports.fetch, input.surfaces.ucp!, now));
  await note("acp", input.surfaces.acp, "no ACP feed address given", () => readAcp(ports.fetch, input.surfaces.acp!, now));

  // Live pages.
  const pages: LivePageRead[] = [];
  const liveByUrl = new Map<string, LivePageRead | null>();
  if (input.surfaces.live_pages !== false) {
    const urls: string[] = [];
    for (const p of record.pages) if (!urls.includes(p.url)) urls.push(p.url);
    const limit = input.maxPages ?? 50;
    for (const url of urls.slice(0, limit)) {
      const r = await readLivePage(ports.fetch, url, now);
      pages.push(r);
      liveByUrl.set(url, r);
    }
    const okCount = pages.filter((p) => p.status === 200).length;
    statuses.push({ surface: "live_page", state: pages.length ? "read" : "absent", url: `https://${record.domain}/`, note: pages.length ? `${okCount} of ${pages.length} signed pages answered 200${urls.length > limit ? `; ${urls.length - limit} not fetched this run` : ""}` : "no signed pages to read", facts: pages.reduce((n, p) => n + p.facts.length, 0) });
  } else statuses.push({ surface: "live_page", state: "absent", url: null, note: "live page reads were turned off for this run", facts: 0 });

  let robotsTxt: string | null = null;
  if (input.surfaces.robots !== false) {
    try {
      const r = await ports.fetch.get(`https://${record.domain}/robots.txt`, {});
      if (r.status === 200) robotsTxt = r.body;
    } catch {
      robotsTxt = null;
    }
  }

  const mismatches = compareAll({ record, reads, pages, at: now });
  const indexability = indexabilityReport(record.pages, liveByUrl, Object.assign({ robotsTxt }, input.indexability ?? {}));
  const run = await buildRun(record.trooth_id, now, statuses, mismatches, indexability);
  await ports.store.saveRun(run);

  // Alerts: dedupe against open, resolve what cleared, cap what is emailed.
  const fresh = await alertsFrom(record.trooth_id, { mismatches, indexability, record }, now);
  const open = await ports.store.openAlerts(record.trooth_id);
  const resolved = resolvedAlerts(open, fresh, now);
  const { fresh: toRaise, duplicates } = dedupeAlerts(fresh, open);
  const sentToday = await ports.store.sentSince(record.trooth_id, startOfDay(now));
  const { send, held } = applyDailyCap(toRaise, sentToday, input.dailyCap ?? DEFAULT_DAILY_CAP);
  await ports.store.saveAlerts(toRaise);
  if (resolved.length) await ports.store.resolveAlerts(resolved.map((a) => a.id), now);
  let emailed = false;
  let emailError: string | null = null;
  if (send.length && input.email && ports.email) {
    const res = await sendAlertEmail(ports.email, send, { from: input.email.from, to: input.email.to, domain: record.domain, actionUrl: input.email.actionUrl });
    if (res.ok) {
      emailed = true;
      await ports.store.markSent(send.map((a) => a.id), now);
    } else emailError = res.error;
  }

  const summary: RunSummary = {
    run_id: run.id,
    ran_at: now,
    counts: countBySeverity(mismatches),
    surfaces: statuses,
    fixes: fixesFrom(mismatches, record),
    pages: { checked: indexability.totals.pages, eligible: indexability.totals.eligible, not_eligible: indexability.totals.not_eligible, jsonld_present: indexability.totals.jsonld_present },
    alerts: { raised: toRaise.length, duplicates: duplicates.length, held_by_cap: held.length, resolved: resolved.length, emailed, email_error: emailError },
    parity: input.surfaces.live_pages !== false ? parity(record.facts, liveByUrl) : null,
  };
  return { run, summary, alerts: toRaise };
}

const GOOGLE_HOSTS: Record<"merchant_center" | "business_profile", string> = { merchant_center: "merchantapi.googleapis.com", business_profile: "mybusinessbusinessinformation.googleapis.com" };

/** The customer's token goes only to Google's own API host, never to a feed url on another host. */
async function tokenFor(connector: "merchant_center" | "business_profile", url: string, ports: MonitorPorts): Promise<string | null> {
  if (!ports.tokens) return null;
  try {
    if (new URL(url).hostname !== GOOGLE_HOSTS[connector]) return null;
  } catch {
    return null;
  }
  return ports.tokens.token(connector);
}

function lowerYour(where: string): string {
  return where.replace(/^Your /, "your ");
}

/** What to fix, in order of effect: trust first, then visibility, then notes; mismatches are already sorted that way. */
export function fixesFrom(mismatches: Mismatch[], record: SignedRecord): Fix[] {
  return mismatches.map((m, i) => ({ order: i + 1, severity: m.severity, key: m.key, surface: m.surface, kind: m.kind, what_to_do: whatToDo(m, record) }));
}

function whatToDo(m: Mismatch, record: SignedRecord): string {
  const where = surfaceWords(m.surface);
  const field = fieldWords(m.key, record);
  if (m.key === "page.jsonld") return `Add the generated JSON-LD block to ${m.surface_url ?? "the page"}.`;
  if (m.key === "page.content") return `Sign the new version of ${m.surface_url ?? "the page"} or restore the signed one.`;
  switch (m.kind) {
    case "differs":
      return `Decide which ${field} is right, then write it to ${lowerYour(where)} or to the record.`;
    case "stale":
      return `Push the signed ${field} to ${lowerYour(where)}.`;
    case "missing_on_surface":
      return `Add ${field} to ${lowerYour(where)}.`;
    case "missing_in_record":
      return `Add ${field} to the signed record if it is right, or remove it from ${lowerYour(where)}.`;
  }
}
