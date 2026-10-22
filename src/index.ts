// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker entry: wires the D1 and R2 ports into the Hono app from
// src/serve/routes.ts and exposes fetch, scheduled and queue handlers
// (Cloudflare Workers module syntax, docs 2026). The compiler, ledger,
// identity, readers, monitor, commerce, gap and basic modules plug in through
// the ports and the RouteDeps hooks; until the coordinator wires them, the
// hooks below are the stubs named in docs/reports/serve.md.

import type { Env, CompileJob } from "./env";
import type { PrivateJwk } from "./core/keys";
import { createApp, runQueue, runScheduled, type RouteDeps } from "./serve/routes";
import type { JobPort, Ports } from "./serve/ports";
import { D1Keys, D1Log, D1Receipts, D1Settings, D1VersionStore } from "./db/d1";

function witnessKey(env: Env): PrivateJwk {
  if (!env.TROOTH_WITNESS_KEY) throw new Error("TROOTH_WITNESS_KEY is not set. Set the witness private JWK as a Worker secret.");
  return JSON.parse(env.TROOTH_WITNESS_KEY) as PrivateJwk;
}

/** Background jobs. The coordinator replaces each with the module that owns it. */
function jobs(_env: Env): JobPort {
  return {
    async hourlyChangeDetection() {
      // src/monitor: change detection for every signed company, enqueue CompileJob with reason change_detected.
    },
    async nightlyCheckpoint() {
      // src/ledger: sign a tree head, request an RFC 3161 timestamp, store both.
    },
    async weeklyGapReports() {
      // src/gap: run the buyer prompts for every company with a provider key.
    },
    async compile(_job: unknown) {
      // src/compiler: build the version for the CompileJob.
    },
  };
}

export function buildPorts(env: Env): Ports {
  const witness = witnessKey(env);
  return {
    versions: new D1VersionStore(env.DB, env.STORE),
    log: new D1Log(env.DB, env.LEDGER_URL),
    keys: new D1Keys(env.DB, env.STORE, witness),
    receipts: new D1Receipts(env.DB),
    settings: new D1Settings(env.DB),
    jobs: jobs(env),
    config: { public_api_base: env.PUBLIC_API_BASE, network_base: env.NETWORK_BASE, ledger_url: env.LEDGER_URL },
    now: () => new Date(),
  };
}

function deps(env: Env): RouteDeps {
  return {
    ports: buildPorts(env),
    // src/readers: Web Bot Auth verification. Until wired, only Signature-Agent presence is recorded.
    readers: undefined,
    // src/identity: workspace authorization for /os routes. Until wired, every /os call answers 401.
    authorize: undefined,
    // KV-backed per-reader limit. Until wired, no limit.
    rateLimit: undefined,
  };
}

let cached: { env: Env; app: ReturnType<typeof createApp>; ports: Ports } | null = null;

function appFor(env: Env) {
  if (!cached || cached.env !== env) {
    const d = deps(env);
    cached = { env, app: createApp(d), ports: d.ports };
  }
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
