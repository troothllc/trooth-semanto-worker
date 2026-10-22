// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Atomic nonce claiming for Web Bot Auth and the connector routes, as a
// Cloudflare Durable Object (developers.cloudflare.com/durable-objects, 2026).
// A Durable Object runs one request at a time per object and its storage
// calls hold the input gate, so a read then a write of one nonce cannot
// interleave with another claim of the same nonce: of two simultaneous claims,
// exactly one is true. KV cannot promise that (it is eventually consistent),
// so src/readers/ports.ts KvNonceStore is only a fallback.
//
// NonceDO has a single operation, claim(nonce, ttl), reachable as a method and
// over fetch (POST /claim with { nonce, ttl_seconds }) so it works with or
// without RPC. Expired entries are swept by an alarm. DurableNonceStore is the
// NonceStore the Worker uses: one object per shard (the key id before the
// first ":", so one agent key's nonces live together), bound as NONCES in
// wrangler.toml.

import type { NonceStore } from "./ports";

/** The storage slice NonceDO needs; a DurableObjectStorage in the Worker, a Map in tests. */
export interface NonceStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm?(scheduledTime: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

export interface NonceState {
  storage: NonceStorage;
  /** Durable Objects run blockConcurrencyWhile callbacks with no other event delivered. */
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
}

const PREFIX = "n:";
const MAX_TTL_SECONDS = 3600;

export class NonceDO {
  /** Claims run one after another even if the platform's input gate is not there (tests, local runs). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: NonceState,
    _env?: unknown,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Claim a nonce for ttl seconds. True the first time inside the window; false for every later claim. */
  async claim(nonce: string, ttlSeconds: number): Promise<boolean> {
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512) return false;
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(1, Math.ceil(Number.isFinite(ttlSeconds) ? ttlSeconds : 1)));
    const run = async (): Promise<boolean> => {
      const now = this.clock();
      const key = PREFIX + nonce;
      const exp = await this.state.storage.get<number>(key);
      if (exp !== undefined && exp > now) return false;
      const until = now + ttl * 1000;
      await this.state.storage.put(key, until);
      if (this.state.storage.setAlarm && this.state.storage.getAlarm) {
        const current = await this.state.storage.getAlarm();
        if (current === null || current > until) await this.state.storage.setAlarm(until);
      }
      return true;
    };
    const serialized = (): Promise<boolean> => (this.state.blockConcurrencyWhile ? this.state.blockConcurrencyWhile(run) : run());
    const result = this.queue.then(serialized, serialized);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Sweep expired nonces, then schedule the next sweep for the earliest one left. */
  async alarm(): Promise<void> {
    const now = this.clock();
    const all = await this.state.storage.list<number>({ prefix: PREFIX });
    let next: number | null = null;
    for (const [k, exp] of all) {
      if (exp <= now) await this.state.storage.delete(k);
      else next = next === null ? exp : Math.min(next, exp);
    }
    if (next !== null && this.state.storage.setAlarm) await this.state.storage.setAlarm(next);
  }

  /** The fetch form: POST /claim { nonce, ttl_seconds } answers { claimed }. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/claim")) return new Response(null, { status: 404 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const b = body as { nonce?: unknown; ttl_seconds?: unknown };
    if (typeof b.nonce !== "string" || typeof b.ttl_seconds !== "number") return new Response(null, { status: 400 });
    const claimed = await this.claim(b.nonce, b.ttl_seconds);
    return new Response(JSON.stringify({ claimed }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

/** The slice of a DurableObjectNamespace this needs. */
export interface NonceNamespace {
  idFromName(name: string): unknown;
  get(id: never): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

/** The NonceStore over the NONCES binding. A failure to reach the object is a refusal (the nonce is not treated as fresh). */
export class DurableNonceStore implements NonceStore {
  constructor(private readonly ns: NonceNamespace) {}
  private stub(key: string) {
    const shard = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
    return this.ns.get(this.ns.idFromName(`nonces:${shard}`) as never);
  }
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    try {
      const res = await this.stub(key).fetch("https://nonce-do.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: key, ttl_seconds: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)) }) });
      if (res.status !== 200) return false;
      return ((await res.json()) as { claimed?: unknown }).claimed === true;
    } catch {
      return false;
    }
  }
  /** The Durable Object answers only claim; a pre-check always says "not seen" and the claim decides. */
  async seen(): Promise<boolean> {
    return false;
  }
}

/** A Map behind the NonceStorage slice, for tests and for local runs. */
export class MemoryNonceStorage implements NonceStorage {
  readonly map = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T = unknown>(opts: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) if (!opts.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
    return out;
  }
}
