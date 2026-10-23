// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The workspace contract of 23 October 2026 behind one object
// (docs/program/CONTRACT-2026-10-23.md, docs/spec/os-api.md). It holds the
// ports the contract needs beside the pipeline's (src/pipeline.ts): its own
// store (src/os/store.ts), the Google OAuth client, the outbound HTTP port for
// Google and Resend, the TROOTH_OS binding and secret for recall events, and
// the queue. Each area lives in its own module and takes this object:
//
//   keys.ts         delivery keys: states, staged rotation, binding, revoke
//   settings.ts     delivery settings preview and audited save
//   receipts.ts     read receipts with filters, a cursor and the CSV
//   connectors.ts   connector keys and the public connect flow for apps
//   google.ts       Connect Google: OAuth 2.0 with PKCE, refresh on use
//   company.ts      signing policy, surfaces, alert addresses
//   writeback.ts    write-back runs that send, through the queue
//   sellers.ts      signed seller lists
//   recalls.ts      recall events to worker-f's changes feed
//   credentials.ts  C2PA credentials made in queue jobs
//
// The routes are in src/serve/os-routes.ts. Every write appends an audit row
// (src/os/common.ts audit). Nothing here runs on a schedule.

import type { Pipeline, ServiceFetcher } from "../pipeline";
import type { EmailPort } from "../monitor/ports";
import type { QueueMessage } from "../env";
import type { CompanyRecord } from "../serve/ports";
import type { OsStore } from "./store";

/** One outbound HTTP call to a fixed host (Google, Resend): never a URL a customer chose. */
export interface OutboundRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}
export interface OutboundResponse {
  status: number;
  body: string;
}
export type OutboundHttp = (url: string, init: OutboundRequest) => Promise<OutboundResponse>;

/** The Worker's fetch as an OutboundHttp: redirects are not followed, 15 seconds at most, the body read as text. */
export function platformOutbound(f: typeof fetch = (input, init) => fetch(input, init)): OutboundHttp {
  return async (url, init) => {
    const res = await f(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.text() };
  };
}

export interface GoogleClient {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export const DEFAULT_GOOGLE_REDIRECT_URI = "https://api.trooth.co/public/semanto/google/callback";
/** Where the dashboard lives; the OAuth callback, the connect approve page and the alert confirmation point here. */
export const DASHBOARD_BASE = "https://trooth.co/dashboard/semanto";

export interface OsDeps {
  pipeline: Pipeline;
  os: OsStore;
  /** Google OAuth client (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI). Without it, Connect Google answers a 409. */
  google?: GoogleClient;
  /** HOSTED_KEY_SEAL_SECRET: seals the Google refresh token (context google-refresh). */
  sealSecret?: string;
  /** Calls to Google's APIs. */
  http: OutboundHttp;
  /** Resend (RESEND_API_KEY) with ALERT_FROM as the sender. Without it, adding an alert address answers a 409. */
  email?: EmailPort;
  from?: string;
  /** worker-f, for recall events (POST /internal/semanto/recall-events). */
  troothOs?: ServiceFetcher;
  /** SEMANTO_EVENTS_SECRET: the HMAC key of Trooth-Event-Signature, set on both Workers. */
  eventsSecret?: string;
  /** The queue (writeback, recall_event and credential messages). Without it the job runs at once, in the request. */
  enqueue?: (m: QueueMessage) => Promise<void>;
  /** The dashboard's base, https://trooth.co/dashboard/semanto unless set. */
  dashboardBase?: string;
  /** One GET of an asset (an image a write-back sent) through the SSRF guard, for the credential job (src/monitor/ports.ts guardedGet). */
  assetProbe?: (url: string) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array; truncated: boolean } | null>;
}

export class OsService {
  constructor(readonly d: OsDeps) {}

  /**
   * Google access tokens by company, kept in this isolate's memory only (never stored) until a minute before they
   * expire, so a write-back run of many items refreshes once, as Google's OAuth guide asks (reuse an access token
   * until it expires). Dropped on disconnect, on a new connection and on any refusal.
   */
  readonly googleTokens = new Map<string, { token: string; until: number }>();

  get store(): OsStore {
    return this.d.os;
  }
  get p(): Pipeline {
    return this.d.pipeline;
  }
  now(): Date {
    return this.d.pipeline.d.now();
  }
  random(n: number): Uint8Array {
    return this.d.pipeline.random(n);
  }
  company(trooth_id: string): Promise<CompanyRecord | null> {
    return this.d.pipeline.d.store.getCompany(trooth_id);
  }
  dashboard(): string {
    return this.d.dashboardBase ?? DASHBOARD_BASE;
  }
  /** The workspace routes' base, https://api.trooth.co/os/semanto. */
  osBase(): string {
    return this.d.pipeline.d.config.public_api_base.replace(/\/public\//, "/os/");
  }
  publicBase(): string {
    return this.d.pipeline.d.config.public_api_base;
  }
  /** Log an exception under a request id; never to the client. */
  logError(request_id: string, action: string, e: unknown): void {
    if (this.d.pipeline.d.logError) this.d.pipeline.d.logError(request_id, action, e);
  }
}
