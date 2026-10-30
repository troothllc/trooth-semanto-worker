// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker entry (Cloudflare Workers module syntax, docs 2026): builds the
// D1, R2, KV, Queue and service-binding ports from Env, wires them into the
// pipeline (src/pipeline.ts) and the Hono app (src/serve/routes.ts), and
// exposes fetch, scheduled and queue handlers. Every module plugs in here and
// nowhere else:
//
//   log        src/ledger TransparencyLog over D1LogStore (D1 rows, R2 tiles),
//              writes serialized through the LogDO Durable Object (LOG)
//   versions   src/db/d1.ts D1VersionStore, D1PipelineStore (R2 bodies)
//   keys       src/db/d1.ts D1Keys, hosted keys sealed with HOSTED_KEY_SEAL_SECRET
//   readers    src/readers Web Bot Auth with a KV key cache, nonces claimed in the
//              NonceDO Durable Object (NONCES), directory hosts resolved over DNS
//              over HTTPS (fail closed), adapters proven by their connector
//              signature; receipts in D1
//   compiler   the company's pages fetched with the shared SSRF guard and the
//              DNS over HTTPS resolver (src/core/ssrf.ts), failing closed
//   authorize  worker-f's session check through the TROOTH_OS service binding;
//              the claim routes accept a session with no company yet
//   commerce   src/db/d1.ts D1CommerceStore behind src/commerce routes
//   monitor    src/monitor with D1 runs and alerts, Resend email; every
//              surface fetched through the shared SSRF guard
//   setup      src/setup: two DNS over HTTPS resolvers, the guarded probe of
//              the company's site, Domain Connect discovery
//   limits     RateLimitDO (RATE): token buckets per client and route group,
//              read receipts counted per minute, directory fetch limits
//   gap        src/gap providers with the keys in Env
//   jobs       a build in queue messages of at most 25 pages; hourly,
//              nightly and weekly crons fan out one message per 25 companies
//   os         the workspace contract of 23 October 2026 (src/os/service.ts,
//              src/serve/os-routes.ts) over D1OsStore: staged key rotation,
//              connector keys and the connect flow, Connect Google, company
//              settings, write-back runs, seller lists, recall events to
//              worker-f and C2PA credentials, its jobs on the same queue
//
// A deployment without TROOTH_WITNESS_KEY still starts: routes that sign or
// witness answer a 503 witness_key_missing problem and the rest keep working.

import { D1AgentKeys } from "./os/agent-keys";
import { serpApiPort } from "./gap/serpapi";
import type { Env, QueueMessage } from "./env";
import { WitnessKeyMissingError, type PrivateJwk, type PublicJwk } from "./core/keys";
import { createApp, runQueue, runScheduled, DASHBOARD_ORIGINS, DEVELOPMENT_DASHBOARD_ORIGIN, type RouteDeps } from "./serve/routes";
import type { Ports } from "./serve/ports";
import { LedgerLogPort } from "./serve/ledger-port";
import { D1BuildStaging, D1CommerceStore, D1Keys, D1MonitorStore, D1PipelineStore, D1Receipts, D1ReceiptStore, D1Settings, D1VersionStore } from "./db/d1";
import { TransparencyLog } from "./ledger/log";
import { D1LogStore } from "./ledger/store-d1";
import { platformFetch } from "./ledger/ports";
import { WebFetchHttp } from "./compiler/ports";
import { platformHttp as identityHttp } from "./identity/ports";
import { webauthnConfig } from "./identity/webauthn";
import { platformHttp as readersHttp, KvKeyCache, KvNonceStore } from "./readers/ports";
import { DurableNonceStore, NonceDO, type NonceNamespace } from "./readers/nonce-do";
import { CountedReceipts, durableDirectoryLimit, durableKeyedLimit, durableRateLimit, RateLimitDO, type RateNamespace } from "./readers/rate-limit";
import { LogDO, durableLogAppender, type LogNamespace } from "./ledger/log-do";
import { dohResolver } from "./core/ssrf";
import { guardedFetchPort, guardedGet, resendEmailPort } from "./monitor/ports";
import { dohSetupDns } from "./setup/ports";
import { GAP_ASK_TIMEOUT_MS, liveAdapters } from "./gap/providers";
import { Pipeline, ReaderReceipts, forwardingFromStore, troothOsAuthorize, troothOsSession, webBotAuthReaders, withCompanies } from "./pipeline";
import { D1OsStore } from "./db/os-d1";
import { DEFAULT_GOOGLE_REDIRECT_URI, OsService, platformOutbound } from "./os/service";
import { withRecallEvents } from "./os/recalls";
import { credentialsForVersion } from "./os/credentials";
import { consumeOs, consumeOsFailed } from "./os/jobs";
import { devDashboardBase, devUpstreamBase, devUpstreamFetch } from "./dev-upstream";

// The Durable Object classes wrangler.toml binds as NONCES, LOG and RATE.
export { NonceDO, LogDO, RateLimitDO };

function witnessKey(env: Env): PrivateJwk | null {
  if (!env.TROOTH_WITNESS_KEY) return null;
  try {
    return JSON.parse(env.TROOTH_WITNESS_KEY) as PrivateJwk;
  } catch {
    return null;
  }
}

function previousWitnessKeys(env: Env): PublicJwk[] {
  if (!env.TROOTH_WITNESS_PREVIOUS_KEYS) return [];
  try {
    const list = JSON.parse(env.TROOTH_WITNESS_PREVIOUS_KEYS) as unknown;
    return Array.isArray(list) ? (list as PublicJwk[]).filter((k) => k && typeof k.kid === "string" && typeof k.x === "string" && !("d" in k)) : [];
  } catch {
    return [];
  }
}

interface Wired {
  env: Env;
  app: ReturnType<typeof createApp>;
  ports: Ports;
  pipeline: Pipeline;
}

export function wire(env: Env): Wired {
  const witness = witnessKey(env);
  const witnessOrThrow = (): PrivateJwk => {
    if (!witness) throw new WitnessKeyMissingError();
    return witness;
  };
  const now = () => new Date();
  // Development only: the fixed upstreams (Google, Resend) and the dashboard on loopback (src/dev-upstream.ts); production gets fetch itself.
  const upstreamFetch = devUpstreamFetch(devUpstreamBase(env));
  const dashboardBase = devDashboardBase(env);
  const config = { public_api_base: env.PUBLIC_API_BASE, network_base: env.NETWORK_BASE, ledger_url: env.LEDGER_URL };
  const versions = new D1VersionStore(env.DB, env.STORE);
  const keys = new D1Keys(env.DB, env.STORE, witness, env.HOSTED_KEY_SEAL_SECRET, previousWitnessKeys(env));
  const settings = new D1Settings(env.DB);
  const logStore = new D1LogStore(env.DB, env.STORE);
  const log = new LedgerLogPort(new TransparencyLog(logStore, witnessOrThrow, now), env.LEDGER_URL, env.LOG ? durableLogAppender(env.LOG as unknown as LogNamespace) : undefined);
  // DNS over HTTPS, failing closed: every fetch of a URL someone else chose checks resolved addresses with it.
  const resolve = dohResolver();
  // Nonces claimed atomically in the NonceDO; the KV store is a fallback that is not atomic.
  const nonces = env.NONCES ? new DurableNonceStore(env.NONCES as unknown as NonceNamespace) : new KvNonceStore(env.CACHE);
  const store = new D1PipelineStore(env.DB, env.STORE, env.HOSTED_KEY_SEAL_SECRET);
  const osStore = new D1OsStore(env.DB, env.STORE);
  // The workspace contract's service is made after the pipeline; these hooks reach it once it exists.
  let os: OsService | null = null;
  // Every recall stored or changed is sent to worker-f's changes feed (src/os/recalls.ts).
  const commerce = withCompanies(withRecallEvents(new D1CommerceStore(env.DB), () => os), store, env.PUBLIC_API_BASE);
  const idHttp = identityHttp();
  const setupDns = dohSetupDns();
  const rate = env.RATE ? (env.RATE as unknown as RateNamespace) : null;
  const receiptStore = new D1ReceiptStore(env.DB);
  const receipts = rate
    ? new CountedReceipts(rate, env.RECEIPT_IP_SALT_SECRET)
    : env.RECEIPT_IP_SALT_SECRET && env.RECEIPT_IP_SALT_SECRET.length >= 16
      ? new ReaderReceipts(receiptStore, env.RECEIPT_IP_SALT_SECRET)
      : new D1Receipts(env.DB);
  // One GET to the company's own site through the SSRF guard (host detection, the install check).
  const siteProbe = async (url: string, headers: Record<string, string>) => {
    const r = await guardedGet(url, headers, { resolve });
    return { status: r.status, headers: r.headers, body: r.body };
  };

  const pipeline = new Pipeline({
    store,
    versions,
    keys,
    settings,
    log,
    logStore,
    commerce,
    config,
    now,
    site: { http: new WebFetchHttp(), resolve },
    monitor: {
      fetch: guardedFetchPort({ resolve }),
      store: new D1MonitorStore(env.DB),
      ...(env.RESEND_API_KEY ? { email: resendEmailPort(env.RESEND_API_KEY, upstreamFetch) } : {}),
      ...(env.ALERT_FROM ? { from: env.ALERT_FROM } : {}),
    },
    identity: { http: idHttp },
    setupDns,
    siteProbe,
    staging: new D1BuildStaging(env.DB, env.STORE),
    receiptStore,
    ...(env.TSA_URL ? { tsa: { url: env.TSA_URL, fetch: platformFetch() } } : {}),
    // Watch what AI says is off until it returns as a paid feature (founder, 2026-10-29): no report asks a paid provider.
    gapReports: false,
    // Paused assistants (src/gap/providers.ts PAUSED_PROVIDERS) are left out of customer reports; each request is cut off after GAP_ASK_TIMEOUT_MS.
    gapAdapters: () => {
      const timed = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => fetch(url, { ...init, signal: AbortSignal.timeout(GAP_ASK_TIMEOUT_MS) });
      return liveAdapters(env, timed, env.SERPAPI_API_KEY ? serpApiPort(env.SERPAPI_API_KEY, timed) : undefined);
    },
    ...(env.COMPILE_QUEUE ? { enqueue: async (job: QueueMessage) => void (await env.COMPILE_QUEUE!.send(job)) } : {}),
    // Production never runs a build inside a request: without the queue, a build is refused.
    inlineBuilds: env.ENVIRONMENT !== "production",
    nonces,
    logError: (request_id, action, error) => console.error(JSON.stringify({ request_id, action, error: error instanceof Error ? error.message : String(error) })),
    // Passkeys release the hosted key: rp id trooth.co unless set; http://localhost only in development.
    webauthn: webauthnConfig({ rp_id: env.WEBAUTHN_RP_ID ?? null, development: env.ENVIRONMENT === "development" }),
    connectorSeen: (kid, at, result) => osStore.recordConnectorRequest(kid, at, result),
    afterAssembled: async (trooth_id, file) => void (os ? await credentialsForVersion(os, trooth_id, file) : 0),
    consumeOs: async (message, attempts) => (os ? consumeOs(os, message, attempts) : false),
    consumeOsFailed: async (message, e) => (os ? consumeOsFailed(os, message, e) : false),
  });
  os = new OsService({
    pipeline,
    os: osStore,
    ...(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET ? { google: { client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI ?? DEFAULT_GOOGLE_REDIRECT_URI } } : {}),
    ...(env.HOSTED_KEY_SEAL_SECRET ? { sealSecret: env.HOSTED_KEY_SEAL_SECRET } : {}),
    http: platformOutbound(upstreamFetch),
    ...(env.RESEND_API_KEY ? { email: resendEmailPort(env.RESEND_API_KEY, upstreamFetch) } : {}),
    ...(dashboardBase ? { dashboardBase } : {}),
    ...(env.ALERT_FROM ? { from: env.ALERT_FROM } : {}),
    ...(env.TROOTH_OS ? { troothOs: env.TROOTH_OS } : {}),
    ...(env.SEMANTO_EVENTS_SECRET ? { eventsSecret: env.SEMANTO_EVENTS_SECRET } : {}),
    ...(env.COMPILE_QUEUE ? { enqueue: async (job: QueueMessage) => void (await env.COMPILE_QUEUE!.send(job)) } : {}),
    assetProbe: (url) => guardedGet(url, { accept: "image/*,application/pdf" }, { resolve, maxBytes: 25 * 1024 * 1024 }),
  });

  const ports: Ports = { versions, log, keys, receipts, settings, jobs: pipeline.jobs(), config, now };
  const deps: RouteDeps = {
    ports,
    readers: webBotAuthReaders(
      { http: readersHttp(), cache: new KvKeyCache(env.CACHE), nonces, resolve, ...(rate ? { limit: durableDirectoryLimit(rate) } : {}) },
      forwardingFromStore(store),
    ),
    agentKeys: new D1AgentKeys(env.DB),
    authorize: troothOsAuthorize(env.TROOTH_OS, async (os_company_id) => (await store.getCompanyByOsCompany(os_company_id))?.trooth_id ?? null, (trooth_id) => store.ownerUserId(trooth_id)),
    session: troothOsSession(env.TROOTH_OS),
    workspace: pipeline,
    commerce,
    firstPublications: { get: (id) => store.getFirstPublication(id) },
    revocations: (trooth_id) => store.getRevocationList(trooth_id),
    benchmarkRows: (from, to) => receiptStore.aggregate(from, to),
    ...(rate ? { rateLimit: durableRateLimit(rate), limit: durableKeyedLimit(rate) } : {}),
    os,
    // The dashboard on trooth.co and www.trooth.co; http://localhost too in development.
    dashboardOrigins: env.ENVIRONMENT === "development" ? [...DASHBOARD_ORIGINS, DEVELOPMENT_DASHBOARD_ORIGIN] : DASHBOARD_ORIGINS,
  };
  return { env, app: createApp(deps), ports, pipeline };
}

let cached: Wired | null = null;

function appFor(env: Env): Wired {
  if (!cached || cached.env !== env) cached = wire(env);
  return cached;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return appFor(env).app.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(appFor(env).ports, event.cron));
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await runQueue(
      appFor(env).ports,
      batch.messages.map((m) => ({ body: m.body, attempts: m.attempts, ack: () => m.ack(), retry: (opts?: { delaySeconds?: number }) => m.retry(opts) })),
    );
  },
};
