// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The monitor's ports: fetching a surface, storing runs and alerts (the D1
// tables semanto_monitor_runs and semanto_alerts), sending email (Resend's
// POST /emails shape, api.resend.com, 2026 docs) and holding the customer's
// OAuth tokens for Google write-back. Every port has an in-memory form here so
// the tests run in Node with no Cloudflare runtime and no network.

import type { Alert, MonitorRun } from "./types";

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

/** A fetch port over the global fetch, for the Worker. Readers only GET; write-back sends with the token the port holds. */
export function globalFetchPort(): FetchPort {
  const toResult = async (res: Response): Promise<FetchResult> => {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  };
  return {
    get: async (url, headers) => toResult(await fetch(url, { method: "GET", headers: headers ?? {}, redirect: "follow" })),
    send: async (url, init) => toResult(await fetch(url, { method: init.method, headers: init.headers, body: init.body })),
  };
}
