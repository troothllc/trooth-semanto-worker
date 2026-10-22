// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// One writer for the public log, as a Cloudflare Durable Object
// (developers.cloudflare.com/durable-objects, 2026). Appends to an RFC 6962
// log must be strictly ordered: two appends that both read size n would both
// claim index n. A single Durable Object instance (idFromName("semanto-log"))
// runs one request at a time, and appends are queued inside it as well, so
// every append reads the frontier the previous one wrote. Reads (tree heads,
// proofs, leaves) do not need it and go to the store directly.
//
// The object answers POST /append { leaf } with the AppendResult and
// POST /sign-tree-head { tree_size? } with the stored tree head. LogDO builds
// its TransparencyLog from its environment (D1 and R2 through D1LogStore,
// the witness key from TROOTH_WITNESS_KEY); tests hand it a log directly.

import { WitnessKeyMissingError, type PrivateJwk } from "@/core/keys";
import { TransparencyLog, type AppendResult } from "./log";
import type { LogLeaf, StoredTreeHead } from "./ports";
import { D1LogStore } from "./store-d1";

interface LogDoEnv {
  DB: D1Database;
  STORE: R2Bucket;
  TROOTH_WITNESS_KEY?: string;
}

export class LogDO {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly log: TransparencyLog;

  constructor(_state: unknown, env: LogDoEnv | null, log?: TransparencyLog) {
    if (log) this.log = log;
    else {
      if (!env) throw new Error("LogDO: no environment");
      // The key is read when a write needs it, so a deployment without it starts and answers a 503 problem instead of failing here.
      const key = env.TROOTH_WITNESS_KEY;
      this.log = new TransparencyLog(new D1LogStore(env.DB, env.STORE), () => {
        if (!key) throw new WitnessKeyMissingError();
        return JSON.parse(key) as PrivateJwk;
      });
    }
  }

  /** Run one log write after every earlier one has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  append(leaf: LogLeaf): Promise<AppendResult> {
    return this.serial(() => this.log.append(leaf));
  }

  signTreeHead(treeSize?: number): Promise<StoredTreeHead> {
    return this.serial(() => this.log.signTreeHead(treeSize));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    let body: { leaf?: LogLeaf; tree_size?: number };
    try {
      body = (await request.json()) as { leaf?: LogLeaf; tree_size?: number };
    } catch {
      return new Response(JSON.stringify({ error: "the body is not JSON" }), { status: 400 });
    }
    try {
      if (path.endsWith("/append") && body.leaf) return Response.json(await this.append(body.leaf));
      if (path.endsWith("/sign-tree-head")) return Response.json(await this.signTreeHead(body.tree_size));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "the log write did not finish" }), { status: 500 });
    }
    return new Response(null, { status: 404 });
  }
}

/** The slice of a DurableObjectNamespace this needs. */
export interface LogNamespace {
  idFromName(name: string): unknown;
  get(id: never): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

/** Appends through the LOG binding: the one LogDO instance named "semanto-log". */
export function durableLogAppender(ns: LogNamespace): { append(leaf: LogLeaf): Promise<AppendResult>; signTreeHead(treeSize?: number): Promise<StoredTreeHead> } {
  const stub = () => ns.get(ns.idFromName("semanto-log") as never);
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await stub().fetch(`https://log-do.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json()) as T & { error?: string };
    if (res.status !== 200) throw new Error(`the log did not take the write: ${j.error ?? res.status}`);
    return j;
  };
  return {
    append: (leaf) => call<AppendResult>("/append", { leaf }),
    signTreeHead: (tree_size) => call<StoredTreeHead>("/sign-tree-head", tree_size === undefined ? {} : { tree_size }),
  };
}
