// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: the Worker wired the way src/index.ts wires it, with
// in-memory ports only, for the workspace contract of 23 October 2026
// (src/os, src/serve/os-routes.ts). The company is the fictional Acme Inc
// (acme.com) from test/fixtures/compiler. Google, Resend, worker-f, DNS over
// HTTPS and the company's own site are fakes named as fixtures; no figure
// here is a measurement.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPair, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { MemoryHttp as SiteHttp } from "@/compiler/ports";
import { MemoryVersionStore, memoryPorts, TEST_CONFIG } from "@/serve/memory-ports";
import { SessionUnavailable } from "@/serve/errors";
import { createApp } from "@/serve/routes";
import type { WorkspaceAuth, WorkspaceSession } from "@/serve/ports";
import { MemoryHttp as IdentityHttp, DOH_URL } from "@/identity/ports";
import { MemoryNonceStore, MemoryReceiptStore } from "@/readers/ports";
import { MemoryRateLimiter } from "@/readers/rate-limit";
import { fetchFromMap, memoryStore, type EmailMessage } from "@/monitor/ports";
import { InMemoryCommerceStore } from "@/commerce/ports";
import { MemoryPipelineStore } from "@/pipeline-store";
import { Pipeline, withCompanies, type ServiceFetcher } from "@/pipeline";
import type { QueueMessage } from "@/env";
import { MemoryOsStore } from "@/os/store";
import { OsService, type OutboundRequest, type OutboundResponse } from "@/os/service";
import { withRecallEvents } from "@/os/recalls";
import { credentialsForVersion } from "@/os/credentials";
import { consumeOs, consumeOsFailed } from "@/os/jobs";
import { memoryWorkspaceDomains } from "@/setup/workspace-domains";
import { PasskeyWallet, passkeySign, addPasskey } from "./passkey";
import type { RequestOptionsJSON } from "@/identity/webauthn";

const COMPILER = fileURLToPath(new URL("../fixtures/compiler/", import.meta.url));
const readCompiler = (name: string) => readFileSync(COMPILER + name, "utf8");

export const NOW = new Date("2026-10-23T12:00:00.000Z");
export const API = TEST_CONFIG.public_api_base;
export const OS = "https://api.trooth.co/os/semanto";
export const SEAL = "fixture-seal-secret-of-forty-characters-x";
export const EVENTS_SECRET = "fixture-events-secret";

const SITE_PAGES: Record<string, string> = {
  "https://acme.com/": "index.html",
  "https://acme.com/about": "about.html",
  "https://acme.com/pricing": "pricing.html",
  "https://acme.com/contact": "contact.html",
};

export const WORKSPACES: Record<string, WorkspaceAuth> = {
  "Bearer owner-token": { trooth_id: "acme", role: "owner", user_id: "u-ada", name: "Ada Owner", domains: memoryWorkspaceDomains([{ domain: "acme.com", status: "confirmed", confirmed_at: "2026-10-21T09:00:00.000Z", method: "dns" }]) },
  "Bearer admin-token": { trooth_id: "acme", role: "admin", user_id: "u-bo", name: "Bo Admin" },
  "Bearer member-token": { trooth_id: "acme", role: "member", user_id: "u-cy", name: "Cy Member" },
  "Bearer viewer-token": { trooth_id: "acme", role: "viewer", user_id: "u-vi", name: "Vi Viewer" },
};

const SESSIONS: Record<string, WorkspaceSession> = {
  "Bearer owner-token": { os_company_id: "co-acme", user_id: "u-ada", name: "Ada Owner", role: "owner", company_slug: null, signed_in_at: null, email: "ada@acme.com" },
  "Bearer stranger-token": { os_company_id: "co-none", user_id: "u-zz", name: "Zed", role: "owner", company_slug: null, signed_in_at: null, email: "zed@example.com" },
};

/** A fixture Google: every call recorded, answers from handlers by URL prefix. */
export class FixtureGoogle {
  readonly calls: { url: string; init: OutboundRequest }[] = [];
  readonly handlers: { prefix: string; answer: (url: string, init: OutboundRequest) => OutboundResponse }[] = [];
  on(prefix: string, answer: (url: string, init: OutboundRequest) => OutboundResponse): void {
    this.handlers.unshift({ prefix, answer });
  }
  http = async (url: string, init: OutboundRequest): Promise<OutboundResponse> => {
    this.calls.push({ url, init });
    const h = this.handlers.find((x) => url.startsWith(x.prefix));
    return h ? h.answer(url, init) : { status: 404, body: "{}" };
  };
}

/** A fixture worker-f behind the TROOTH_OS binding. */
export class FixtureWorkerF implements ServiceFetcher {
  readonly requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  status = 200;
  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    this.requests.push({ url, headers, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: this.status < 300 }), { status: this.status });
  }
}

export interface OsWorld {
  clock: { now: Date };
  witness: PrivateJwk;
  versions: MemoryVersionStore;
  store: MemoryPipelineStore;
  osStore: MemoryOsStore;
  pipeline: Pipeline;
  os: OsService;
  app: ReturnType<typeof createApp>;
  commerce: ReturnType<typeof withCompanies>;
  google: FixtureGoogle;
  workerF: FixtureWorkerF;
  emails: EmailMessage[];
  queued: QueueMessage[];
  receipts: MemoryReceiptStore;
  dns: Record<string, string[]>;
  probes: Record<string, { status: number; headers: Record<string, string>; body: Uint8Array }>;
  wallet: PasskeyWallet;
}

export async function osWorld(opts: { custody?: "hosted" | "customer"; queue?: boolean; email?: boolean; google?: boolean; workerF?: boolean } = {}): Promise<OsWorld> {
  const clock = { now: new Date(NOW) };
  const now = () => new Date(clock.now);
  const w = await generateKeyPair();
  const versions = new MemoryVersionStore();
  const ports = memoryPorts(versions, w.privateJwk, { now });
  const store = new MemoryPipelineStore(versions);
  await store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full", legal_name: "Acme Inc", current_version: null, custody: opts.custody ?? "hosted", domain_proven_at: NOW.toISOString(), os_company_id: "co-acme" });
  const site = new SiteHttp();
  site.set("https://acme.com/robots.txt", { body: readCompiler("robots.txt"), headers: { "content-type": "text/plain" } });
  site.set("https://acme.com/sitemap.xml", { body: readCompiler("sitemap.xml"), headers: { "content-type": "application/xml" } });
  for (const [url, file] of Object.entries(SITE_PAGES)) site.set(url, { body: readCompiler(file), headers: { "content-type": "text/html; charset=utf-8" } });
  const dns: Record<string, string[]> = {};
  const identityHttp = new IdentityHttp(
    new Proxy({} as Record<string, (url: string) => { status: number; headers: Record<string, string>; body: string }>, {
      get: (_t, url: string) =>
        url.startsWith(DOH_URL)
          ? () => {
              const name = decodeURIComponent(/name=([^&]+)/.exec(url)?.[1] ?? "");
              return { status: 200, headers: {}, body: JSON.stringify({ Status: 0, Answer: (dns[name] ?? []).map((d) => ({ type: 16, data: `"${d}"` })) }) };
            }
          : undefined,
    }),
  );
  const queued: QueueMessage[] = [];
  const receipts = new MemoryReceiptStore();
  const probes: OsWorld["probes"] = {};
  let os: OsService | null = null;
  const commerce = withCompanies(withRecallEvents(new InMemoryCommerceStore(), () => os), store, API);
  const osStore = new MemoryOsStore(store);
  const pipeline = new Pipeline({
    store,
    versions,
    keys: ports.keys,
    settings: ports.settings,
    log: ports.log,
    logStore: ports.log.store,
    commerce,
    config: TEST_CONFIG,
    now,
    site: { http: site, fetcher: { minIntervalMs: 0 } },
    monitor: { fetch: fetchFromMap({}), store: memoryStore() },
    identity: { http: identityHttp },
    gapAdapters: () => [],
    receiptStore: receipts,
    nonces: new MemoryNonceStore(),
    siteProbe: async (url) => probes[url] ?? null,
    ...(opts.queue ? { enqueue: async (job: QueueMessage) => void queued.push(job) } : {}),
    connectorSeen: (kid, at, result) => osStore.recordConnectorRequest(kid, at, result),
    afterAssembled: async (trooth_id, file) => void (os ? await credentialsForVersion(os, trooth_id, file) : 0),
    consumeOs: async (m, attempts) => (os ? consumeOs(os, m, attempts) : false),
    consumeOsFailed: async (m, e) => (os ? consumeOsFailed(os, m, e) : false),
  });
  const google = new FixtureGoogle();
  const workerF = new FixtureWorkerF();
  const emails: EmailMessage[] = [];
  os = new OsService({
    pipeline,
    os: osStore,
    ...(opts.google === false ? {} : { google: { client_id: "fixture-client.apps.googleusercontent.com", client_secret: "fixture-client-secret", redirect_uri: "https://api.trooth.co/public/semanto/google/callback" } }),
    sealSecret: SEAL,
    http: google.http,
    ...(opts.email === false ? {} : { email: { send: async (m: EmailMessage) => (emails.push(m), { ok: true as const, id: `email-${emails.length}` }) }, from: "alerts@trooth.co" }),
    ...(opts.workerF === false ? {} : { troothOs: workerF, eventsSecret: EVENTS_SECRET }),
    ...(opts.queue ? { enqueue: async (job: QueueMessage) => void queued.push(job) } : {}),
    assetProbe: async (url) => (probes[url] ? { ...probes[url]!, truncated: false } : null),
  });
  const limiter = new MemoryRateLimiter(() => clock.now.getTime());
  const app = createApp({
    ports: { ...ports, jobs: pipeline.jobs() },
    // "Bearer session-down": the session service does not answer (QA-12).
    authorize: async (req) => (req.headers.get("authorization") === "Bearer session-down" ? sessionDown() : (WORKSPACES[req.headers.get("authorization") ?? ""] ?? null)),
    session: async (req) => (req.headers.get("authorization") === "Bearer session-down" ? sessionDown() : (SESSIONS[req.headers.get("authorization") ?? ""] ?? null)),
    workspace: pipeline,
    commerce,
    os,
    limit: (key, group) => limiter.take(key, group),
    rateLimit: limiter.hook(),
    revocations: (id) => store.getRevocationList(id),
  });
  return { clock, witness: w.privateJwk, versions, store, osStore, pipeline, os, app, commerce, google, workerF, emails, queued, receipts, dns, probes, wallet: new PasskeyWallet() };
}

function sessionDown(): never {
  throw new SessionUnavailable(503);
}

export const post = (w: OsWorld, path: string, body: unknown, token = "Bearer owner-token", headers: Record<string, string> = {}) =>
  w.app.request(`${OS}${path}`, { method: "POST", headers: { authorization: token, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
export const get = (w: OsWorld, path: string, token = "Bearer owner-token") => w.app.request(`${OS}${path}`, { headers: { authorization: token } });
export const pub = (w: OsWorld, path: string, init: RequestInit = {}) => w.app.request(`${API}${path}`, init);
export const json = async (r: Response) => (await r.json()) as Record<string, any>;

/** Build and sign the first version with the hosted key, the passkey step included. */
export async function buildAndSign(w: OsWorld): Promise<void> {
  const built = await post(w, "/acme/build", {});
  if (built.status === 202) await drain(w);
  else if (built.status !== 200) throw new Error(`build answered ${built.status}: ${await built.text()}`);
  const signed = await passkeySign((path, b, t) => post(w, path, b, t), "acme", "Bearer owner-token", w.wallet);
  if (signed.status !== 200) throw new Error(`sign answered ${signed.status}: ${await signed.text()}`);
}

/** A passkey assertion for a purpose (key rotation or seller list): options, a passkey added first when there is none, the assertion. */
export async function purposeAssertion(w: OsWorld, body: Record<string, unknown>, token = "Bearer owner-token"): Promise<unknown> {
  const auth = await w.wallet.for(token);
  let opts = await post(w, "/acme/sign/options", body, token);
  if (opts.status === 409 && ((await opts.clone().json()) as { code?: string }).code === "passkey_missing") {
    await addPasskey((p, b, t) => post(w, p, b, t), "acme", token, auth);
    opts = await post(w, "/acme/sign/options", body, token);
  }
  if (opts.status !== 200) throw new Error(`sign/options answered ${opts.status}: ${await opts.text()}`);
  const o = (await opts.json()) as { publicKey: RequestOptionsJSON };
  return auth.assert(o.publicKey);
}

/** Run every queued message (and what they queue) as the consumer would, on its first attempt. */
export async function drain(w: OsWorld): Promise<void> {
  while (w.queued.length) await w.pipeline.jobs().compile(w.queued.shift(), 1);
}

export type { PublicJwk };
