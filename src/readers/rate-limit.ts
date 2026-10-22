// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Rate limits and read-receipt counting (pre-deploy audit finding 8).
//
//   token bucket   per client address and route group, the classic token
//                  bucket (a burst, then a steady refill), as Cloudflare's
//                  own rate limiting and most API gateways describe it. Over
//                  the limit is a 429 problem with Retry-After (RFC 6585,
//                  RFC 9110 section 10.2.3).
//   RateLimitDO    the Durable Object bound as RATE: one object per client
//                  address holds that client's buckets; one object per
//                  company counts its read receipts per minute and writes them
//                  to D1 in one batch a minute (an alarm), so a read never
//                  writes a D1 row of its own.
//   directory      the Web Bot Auth key directory fetch is limited per
//                  directory origin and per client address, so a flood of
//                  fresh Signature-Agent origins cannot make the Worker fetch.
//
// Cloudflare's rate limiting binding (the "ratelimit" binding type, Workers
// docs 2026) is an alternative for the token buckets; it has no per-minute
// receipt counting, which is why the Durable Object is used here.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId } from "../core/ids";
import type { ReceiptInput, ReceiptPort } from "../serve/ports";
import type { RouteGroup } from "../serve/routes";
import { makeReceipt } from "./receipts";
import { D1ReceiptStore, type ReceiptRow } from "./ports";

export type LimitGroup = RouteGroup | "directory_origin" | "directory_client";

export interface Limit {
  /** Requests allowed at once. */
  burst: number;
  /** Tokens added per second after that. */
  per_second: number;
}

export const RATE_LIMITS: Record<LimitGroup, Limit> = {
  read: { burst: 120, per_second: 2 },
  log: { burst: 60, per_second: 2 },
  check: { burst: 10, per_second: 0.2 },
  directory_origin: { burst: 5, per_second: 1 / 60 },
  directory_client: { burst: 10, per_second: 1 / 60 },
};

export interface Bucket {
  tokens: number;
  updated_ms: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Whole seconds until one token is back; 0 when allowed. */
  retry_after: number;
  bucket: Bucket;
}

/** Refill, then take one token. Pure. */
export function take(bucket: Bucket | null, limit: Limit, nowMs: number): TakeResult {
  const prev = bucket ?? { tokens: limit.burst, updated_ms: nowMs };
  const elapsed = Math.max(0, (nowMs - prev.updated_ms) / 1000);
  const tokens = Math.min(limit.burst, prev.tokens + elapsed * limit.per_second);
  if (tokens >= 1) return { allowed: true, retry_after: 0, bucket: { tokens: tokens - 1, updated_ms: nowMs } };
  return { allowed: false, retry_after: Math.max(1, Math.ceil((1 - tokens) / limit.per_second)), bucket: { tokens, updated_ms: nowMs } };
}

/** The client address: Cloudflare's own CF-Connecting-IP, which a client cannot set on a Cloudflare-proxied request. */
export function clientAddress(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/** In memory, for tests and local runs. */
export class MemoryRateLimiter {
  readonly buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly limits: Record<LimitGroup, Limit> = RATE_LIMITS) {}
  async take(key: string, group: LimitGroup): Promise<{ allowed: boolean; retry_after: number }> {
    const k = `${group}:${key}`;
    const r = take(this.buckets.get(k) ?? null, this.limits[group], this.now());
    this.buckets.set(k, r.bucket);
    return { allowed: r.allowed, retry_after: r.retry_after };
  }
  /** The route hook (RouteDeps.rateLimit). */
  hook(): (req: Request, group: RouteGroup) => Promise<{ allowed: boolean; retry_after: number }> {
    return (req, group) => this.take(clientAddress(req), group);
  }
}

// ---------------------------------------------------------------- read receipts counted per minute

/** The row a read is counted into: the receipt with its time floored to the minute and an id over the key and the minute. */
export async function minuteRow(r: ReceiptRow): Promise<ReceiptRow> {
  const minute = `${r.read_at.slice(0, 16)}:00.000Z`;
  const { id: _id, read_at: _at, count: _count, ...key } = r;
  return { ...key, read_at: minute, id: semantoId("smd", await digest(canonicalize({ ...key, minute }))), count: 1 };
}

/** Add a row into the minute's counts. Pure. */
export function addToCounts(counts: Map<string, ReceiptRow>, row: ReceiptRow): void {
  const prev = counts.get(row.id);
  counts.set(row.id, prev ? { ...prev, count: (prev.count ?? 1) + (row.count ?? 1) } : { ...row });
}

// ---------------------------------------------------------------- the Durable Object

interface DoState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(keys: string[]): Promise<number | boolean>;
    list<T>(opts: { prefix: string }): Promise<Map<string, T>>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
}

export const RECEIPT_FLUSH_MS = 60_000;

/** RateLimitDO, bound as RATE in wrangler.toml (migration tag v2-rate-limit-durable-object). */
export class RateLimitDO {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly state: DoState,
    private readonly env: { DB?: D1Database },
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/take") {
      const { key, group } = (await request.json()) as { key: string; group: LimitGroup };
      const limit = RATE_LIMITS[group];
      if (!limit) return Response.json({ allowed: true, retry_after: 0 });
      const r = take(this.buckets.get(`${group}:${key}`) ?? null, limit, Date.now());
      this.buckets.set(`${group}:${key}`, r.bucket);
      return Response.json({ allowed: r.allowed, retry_after: r.retry_after });
    }
    if (path === "/receipt") {
      const row = await minuteRow((await request.json()) as ReceiptRow);
      const stored = await this.state.storage.get<ReceiptRow>(`r:${row.id}`);
      await this.state.storage.put(`r:${row.id}`, stored ? { ...stored, count: (stored.count ?? 1) + 1 } : row);
      if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + RECEIPT_FLUSH_MS);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  /** Once a minute: every counted row in one D1 batch, counts added to any row already written for the same minute. */
  async alarm(): Promise<void> {
    if (!this.env.DB) return;
    const rows = await this.state.storage.list<ReceiptRow>({ prefix: "r:" });
    if (!rows.size) return;
    await new D1ReceiptStore(this.env.DB).putMany([...rows.values()]);
    await this.state.storage.delete([...rows.keys()]);
  }
}

/** The slice of a Durable Object namespace the clients need. */
export interface RateNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

async function call(ns: RateNamespace, name: string, path: string, body: unknown): Promise<Response> {
  return ns.get(ns.idFromName(name)).fetch(`https://rate.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** The route hook over RATE: one object per client address. A failing object lets the request through (the limit protects; it never blocks readers on its own fault). */
export function durableRateLimit(ns: RateNamespace): (req: Request, group: RouteGroup) => Promise<{ allowed: boolean; retry_after: number }> {
  return async (req, group) => {
    const key = clientAddress(req);
    try {
      return (await (await call(ns, `ip:${key}`, "/take", { key, group })).json()) as { allowed: boolean; retry_after: number };
    } catch {
      return { allowed: true, retry_after: 0 };
    }
  };
}

/** The Web Bot Auth directory limiter over RATE (WebBotAuthDeps.limit): one object per directory origin and per client. */
export function durableDirectoryLimit(ns: RateNamespace): (key: string, group: "directory_origin" | "directory_client") => Promise<boolean> {
  return async (key, group) => {
    try {
      return ((await (await call(ns, `${group}:${key}`, "/take", { key, group })).json()) as { allowed: boolean }).allowed;
    } catch {
      return true;
    }
  };
}

/**
 * The receipt port over RATE: the address is hashed with the day's salt here
 * (src/readers/receipts.ts) and only the hash travels; the company's object
 * counts it into the minute.
 */
export class CountedReceipts implements ReceiptPort {
  constructor(
    private readonly ns: RateNamespace,
    private readonly secret: string | undefined,
  ) {}
  async record(input: ReceiptInput): Promise<void> {
    const auth = input.proof === "web_bot_auth" && input.agent_key_url && input.keyid ? { proven: true as const, agent_key_url: input.agent_key_url, keyid: input.keyid, directory_signed: false } : null;
    const row: ReceiptRow = this.secret && this.secret.length >= 16
      ? await makeReceipt({ trooth_id: input.trooth_id, version: input.version, page_id: input.page_id, representation: input.representation, auth, read_at: new Date(input.read_at), address: input.address ?? "0.0.0.0" }, this.secret)
      : { id: "", trooth_id: input.trooth_id, version: input.version, page_id: input.page_id, representation: input.representation, agent_key_url: auth ? auth.agent_key_url : null, keyid: auth ? auth.keyid : null, proof: auth ? "web_bot_auth" : "none", read_at: input.read_at, ip_hash: "" };
    await call(this.ns, `receipts:${input.trooth_id}`, "/receipt", row);
  }
}
