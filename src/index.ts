// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker entry (Cloudflare Workers module syntax, docs 2026): builds the
// D1, R2, KV, Queue and service-binding ports from Env, wires them into the
// pipeline (src/pipeline.ts) and the Hono app (src/serve/routes.ts), and
// exposes fetch, scheduled and queue handlers. Every module plugs in here and
// nowhere else:
//
//   log        src/ledger TransparencyLog over D1LogStore (D1 rows, R2 tiles)
//   versions   src/db/d1.ts D1VersionStore, D1PipelineStore (R2 bodies)
//   keys       src/db/d1.ts D1Keys, hosted keys sealed with HOSTED_KEY_SEAL_SECRET
//   readers    src/readers Web Bot Auth with KV key cache and nonces; receipts in D1
//   authorize  worker-f's session check through the TROOTH_OS service binding
//   commerce   src/db/d1.ts D1CommerceStore behind src/commerce routes
//   monitor    src/monitor with D1 runs and alerts, Resend email
//   gap        src/gap providers with the keys in Env
//   jobs       compile on the queue; hourly, nightly and weekly crons

import type { Env, CompileJob } from "./env";
import type { PrivateJwk } from "./core/keys";
import { createApp, runQueue, runScheduled, type RouteDeps } from "./serve/routes";
import type { Ports } from "./serve/ports";
import { LedgerLogPort } from "./serve/ledger-port";
import { D1CommerceStore, D1Keys, D1MonitorStore, D1PipelineStore, D1Receipts, D1ReceiptStore, D1Settings, D1VersionStore } from "./db/d1";
import { TransparencyLog } from "./ledger/log";
import { D1LogStore } from "./ledger/store-d1";
import { platformFetch } from "./ledger/ports";
import { WebFetchHttp } from "./compiler/ports";
import { platformHttp as identityHttp, dohDns } from "./identity/ports";
import { platformHttp as readersHttp, KvKeyCache, KvNonceStore } from "./readers/ports";
import { globalFetchPort, resendEmailPort } from "./monitor/ports";
import { allAdapters } from "./gap/providers";
import { Pipeline, ReaderReceipts, troothOsAuthorize, webBotAuthReaders, withCompanies } from "./pipeline";

function witnessKey(env: Env): PrivateJwk {
  if (!env.TROOTH_WITNESS_KEY) throw new Error("TROOTH_WITNESS_KEY is not set. Set the witness private JWK as a Worker secret.");
  return JSON.parse(env.TROOTH_WITNESS_KEY) as PrivateJwk;
}

interface Wired {
  env: Env;
  app: ReturnType<typeof createApp>;
  ports: Ports;
  pipeline: Pipeline;
}

export function wire(env: Env): Wired {
  const witness = witnessKey(env);
  const now = () => new Date();
  const config = { public_api_base: env.PUBLIC_API_BASE, network_base: env.NETWORK_BASE, ledger_url: env.LEDGER_URL };
  const versions = new D1VersionStore(env.DB, env.STORE);
  const keys = new D1Keys(env.DB, env.STORE, witness, env.HOSTED_KEY_SEAL_SECRET);
  const settings = new D1Settings(env.DB);
  const logStore = new D1LogStore(env.DB, env.STORE);
  const log = new LedgerLogPort(new TransparencyLog(logStore, witness, now), env.LEDGER_URL);
  const store = new D1PipelineStore(env.DB, env.STORE, env.HOSTED_KEY_SEAL_SECRET);
  const commerce = withCompanies(new D1CommerceStore(env.DB), store, env.PUBLIC_API_BASE);
  const idHttp = identityHttp();
  const dns = dohDns(idHttp);
  const receipts = env.RECEIPT_IP_SALT_SECRET && env.RECEIPT_IP_SALT_SECRET.length >= 16 ? new ReaderReceipts(new D1ReceiptStore(env.DB), env.RECEIPT_IP_SALT_SECRET) : new D1Receipts(env.DB);

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
    site: { http: new WebFetchHttp() },
    monitor: {
      fetch: globalFetchPort(),
      store: new D1MonitorStore(env.DB),
      ...(env.RESEND_API_KEY ? { email: resendEmailPort(env.RESEND_API_KEY) } : {}),
      ...(env.ALERT_FROM ? { from: env.ALERT_FROM } : {}),
    },
    identity: { http: idHttp },
    domainProof: {
      dnsTxt: (name) => dns.txt(name),
      fetchText: async (url) => {
        const r = await idHttp.get(url, { accept: "text/plain" });
        return r.status === 200 ? r.body : null;
      },
    },
    ...(env.TSA_URL ? { tsa: { url: env.TSA_URL, fetch: platformFetch() } } : {}),
    gapAdapters: () => allAdapters(env, (url, init) => fetch(url, init)),
    ...(env.COMPILE_QUEUE ? { enqueue: async (job: CompileJob) => void (await env.COMPILE_QUEUE!.send(job)) } : {}),
  });

  const ports: Ports = { versions, log, keys, receipts, settings, jobs: pipeline.jobs(), config, now };
  const deps: RouteDeps = {
    ports,
    readers: webBotAuthReaders({ http: readersHttp(), cache: new KvKeyCache(env.CACHE), nonces: new KvNonceStore(env.CACHE) }),
    authorize: troothOsAuthorize(env.TROOTH_OS),
    workspace: pipeline,
    commerce,
    // KV-backed per-reader limit: not wired yet (founder step: limits per route).
    rateLimit: undefined,
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
  async queue(batch: MessageBatch<CompileJob>, env: Env): Promise<void> {
    await runQueue(
      appFor(env).ports,
      batch.messages.map((m) => ({ body: m.body, ack: () => m.ack(), retry: () => m.retry() })),
    );
  },
};
