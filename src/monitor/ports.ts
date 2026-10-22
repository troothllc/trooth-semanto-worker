// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The monitor's ports: fetching a surface, storing runs and alerts (the D1
// tables semanto_monitor_runs and semanto_alerts), sending email (Resend's
// POST /emails shape, api.resend.com, 2026 docs) and holding the customer's
// OAuth tokens for Google write-back. Every port has an in-memory form here so
// the tests run in Node with no Cloudflare runtime and no network.

import type { Alert, MonitorRun } from "./types";
import { checkUrlResolved, type Resolver } from "../core/ssrf";

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FetchPort {
  get(url: string, headers?: Record<string, string>): Promise<FetchResult>;
  /** Used only by write-back send; never by readers. */
  send?(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<FetchResult>;
}

export interface ClockPort {
  now(): Date;
}

export interface StorePort {
  saveRun(run: MonitorRun): Promise<void>;
  /** Alerts for a company with resolved_at null. */
  openAlerts(trooth_id: string): Promise<Alert[]>;
  saveAlerts(alerts: Alert[]): Promise<void>;
  /** How many alerts were sent to this company since the instant given. */
  sentSince(trooth_id: string, sinceIso: string): Promise<number>;
  markSent(ids: string[], atIso: string): Promise<void>;
  resolveAlerts(ids: string[], atIso: string): Promise<void>;
}

/** Resend-shaped: POST https://api.resend.com/emails with { from, to, subject, text, html }. */
export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailPort {
  send(message: EmailMessage): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}

export type WritebackConnector = "merchant_center" | "business_profile";

export interface TokenPort {
  /** The customer's OAuth access token for the Google API named, or null when the customer has not connected it. */
  token(connector: WritebackConnector): Promise<string | null>;
}

export interface MonitorPorts {
  fetch: FetchPort;
  clock: ClockPort;
  store: StorePort;
  email?: EmailPort;
  tokens?: TokenPort;
}

// ------------------------------------------------------------ in-memory

export function fixedClock(iso: string): ClockPort {
  return { now: () => new Date(iso) };
}

/** A fetch port over a map of url to result; a missing url answers 404 with an empty body. */
export function fetchFromMap(routes: Record<string, FetchResult | string>, sent: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = []): FetchPort {
  const lookup = (url: string): FetchResult => {
    const r = routes[url];
    if (r === undefined) return { status: 404, headers: {}, body: "" };
    if (typeof r === "string") return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: r };
    return r;
  };
  return {
    get: async (url) => lookup(url),
    send: async (url, init) => {
      sent.push({ url, method: init.method, body: init.body, headers: init.headers });
      return { status: 200, headers: {}, body: "{}" };
    },
  };
}

export function memoryStore(): StorePort & { runs: MonitorRun[]; alerts: Alert[] } {
  const runs: MonitorRun[] = [];
  const alerts: Alert[] = [];
  return {
    runs,
    alerts,
    saveRun: async (run) => {
      runs.push(run);
    },
    openAlerts: async (trooth_id) => alerts.filter((a) => a.trooth_id === trooth_id && a.resolved_at === null),
    saveAlerts: async (fresh) => {
      for (const a of fresh) alerts.push(a);
    },
    sentSince: async (trooth_id, sinceIso) => alerts.filter((a) => a.trooth_id === trooth_id && a.sent_at !== null && a.sent_at >= sinceIso).length,
    markSent: async (ids, atIso) => {
      for (const a of alerts) if (ids.includes(a.id)) a.sent_at = atIso;
    },
    resolveAlerts: async (ids, atIso) => {
      for (const a of alerts) if (ids.includes(a.id) && a.resolved_at === null) a.resolved_at = atIso;
    },
  };
}

export function memoryEmail(): EmailPort & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
      return { ok: true, id: `mem_${sent.length}` };
    },
  };
}

export function memoryTokens(tokens: Partial<Record<WritebackConnector, string>>): TokenPort {
  return { token: async (c) => tokens[c] ?? null };
}

/** The caps every fetch of a URL someone else chose obeys (pre-deploy audit finding 9). */
export const GUARDED_MAX_BYTES = 2 * 1024 * 1024;
export const GUARDED_TIMEOUT_MS = 10_000;
export const GUARDED_MAX_REDIRECTS = 5;

export interface GuardedResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
}

export class GuardRefused extends Error {}

/**
 * One GET through the shared SSRF guard (src/core/ssrf.ts): https only, no
 * private, reserved, metadata or local name or address (the resolved
 * addresses too when a resolver is given), redirects followed by hand and
 * each hop checked again (at most five), a timeout, and the body cut at
 * 2 MB. Every fetch of a member-supplied or company URL goes through here:
 * the monitor's surfaces, the setup proof's well-known file, host detection
 * and the install check.
 */
export async function guardedGet(url: string, headers: Record<string, string>, opts: { fetchImpl?: typeof fetch; resolve?: Resolver; maxBytes?: number; timeoutMs?: number } = {}): Promise<GuardedResult> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const maxBytes = opts.maxBytes ?? GUARDED_MAX_BYTES;
  let current = url;
  for (let hop = 0; hop <= GUARDED_MAX_REDIRECTS; hop++) {
    const check = await checkUrlResolved(current, opts.resolve);
    if (!check.ok) throw new GuardRefused(`${current} is not fetched: ${check.detail} (${check.reason})`);
    const res = await fetchImpl(current, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? GUARDED_TIMEOUT_MS) });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = h["location"];
      if (!loc) throw new GuardRefused(`${current} answered ${res.status} without a location`);
      current = new URL(loc, current).href;
      continue;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.length > maxBytes) {
          chunks.push(value.slice(0, maxBytes - total));
          total = maxBytes;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    }
    const body = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      body.set(c, o);
      o += c.length;
    }
    return { status: res.status, headers: h, body, truncated };
  }
  throw new GuardRefused(`${url} redirected more than ${GUARDED_MAX_REDIRECTS} times`);
}

/** The monitor's fetch port for the Worker: every surface read goes through guardedGet. Write-back sends only to the two Google API hosts. */
export function guardedFetchPort(opts: { fetchImpl?: typeof fetch; resolve?: Resolver } = {}): FetchPort {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    get: async (url, headers) => {
      const r = await guardedGet(url, headers ?? {}, { fetchImpl, ...(opts.resolve ? { resolve: opts.resolve } : {}) });
      return { status: r.status, headers: r.headers, body: new TextDecoder().decode(r.body) };
    },
    send: async (url, init) => {
      const host = new URL(url).hostname;
      if (!WRITEBACK_HOSTS.has(host) || !url.startsWith("https://")) throw new GuardRefused(`write-back sends only to ${[...WRITEBACK_HOSTS].join(" and ")}`);
      const res = await fetchImpl(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(GUARDED_TIMEOUT_MS) });
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        h[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: h, body: await res.text() };
    },
  };
}

/** Where write-back may send: the Merchant Center and Business Profile APIs. */
export const WRITEBACK_HOSTS = new Set(["shoppingcontent.googleapis.com", "mybusinessbusinessinformation.googleapis.com"]);

/** Kept for callers that name it: the guarded port over the global fetch. */
export function globalFetchPort(): FetchPort {
  return guardedFetchPort();
}

/** The Resend email port for the Worker: POST https://api.resend.com/emails with a bearer key (Resend API, 2026). */
export function resendEmailPort(apiKey: string, f: typeof fetch = fetch): EmailPort {
  return {
    send: async (message) => {
      try {
        const res = await f("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, error: `Resend answered ${res.status}` };
        const id = (JSON.parse(text || "{}") as { id?: string }).id ?? "";
        return { ok: true, id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "the email could not be sent" };
      }
    },
  };
}
