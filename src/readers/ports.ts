// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ports for the readers layer: fetching an agent's key directory, caching it
// (KV in the Worker, a Map in tests), remembering nonces for the replay window,
// and storing read receipts (D1 in the Worker, a list in tests). Logic in this
// folder never touches a binding directly.

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** True when the body was longer than the cap and was cut; the caller must not use it. */
  tooLarge?: boolean;
}

export interface HttpGetOptions {
  /** Read at most this many bytes of body; more sets tooLarge. */
  maxBytes?: number;
  /** Give up after this many milliseconds. */
  timeoutMs?: number;
}

export interface HttpPort {
  get(url: string, headers?: Record<string, string>, opts?: HttpGetOptions): Promise<HttpResponse>;
}

export class MemoryHttp implements HttpPort {
  readonly calls: string[] = [];
  constructor(private readonly routes: Record<string, HttpResponse | (() => HttpResponse | Promise<HttpResponse>)>) {}
  async get(url: string): Promise<HttpResponse> {
    this.calls.push(url);
    const r = this.routes[url];
    if (!r) return { status: 404, headers: {}, body: "" };
    return typeof r === "function" ? r() : r;
  }
}

/**
 * The Worker's fetch with the guards an outbound request to a URL someone
 * else named needs: redirects are never followed (a 3xx comes back as is and
 * the caller refuses it), the body is read up to maxBytes and no further, and
 * the request is aborted after timeoutMs. The URL itself is checked by the
 * caller with src/core/ssrf.ts before this is called.
 */
export function platformHttp(f: typeof fetch = (input, init) => fetch(input, init)): HttpPort {
  return {
    async get(url, headers = {}, opts = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
      try {
        const res = await f(url, { method: "GET", headers, redirect: "manual", signal: ctrl.signal });
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          h[k.toLowerCase()] = v;
        });
        const cap = opts.maxBytes ?? Number.MAX_SAFE_INTEGER;
        const declared = Number(h["content-length"] ?? "0");
        if (declared > cap) {
          await res.body?.cancel();
          return { status: res.status, headers: h, body: "", tooLarge: true };
        }
        if (!res.body) return { status: res.status, headers: h, body: "" };
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cap) {
            await reader.cancel();
            return { status: res.status, headers: h, body: "", tooLarge: true };
          }
          chunks.push(value);
        }
        const all = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.byteLength;
        }
        return { status: res.status, headers: h, body: new TextDecoder().decode(all) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------- key cache

export interface CachedDirectory {
  /** The JWK Set body as fetched. */
  body: string;
  /** Response headers kept for the directory's own signature check. */
  headers: Record<string, string>;
  fetched_at: string;
  /** Unix ms when the cache entry is stale. */
  expires_at: number;
}

export interface KeyCache {
  get(url: string): Promise<CachedDirectory | null>;
  put(url: string, entry: CachedDirectory): Promise<void>;
  /** The negative cache: until when (unix ms) a fetch to this origin is not tried again after a failure, or null. */
  getFailure(origin: string): Promise<number | null>;
  putFailure(origin: string, untilMs: number): Promise<void>;
}

export class MemoryKeyCache implements KeyCache {
  readonly map = new Map<string, CachedDirectory>();
  readonly failures = new Map<string, number>();
  async get(url: string): Promise<CachedDirectory | null> {
    return this.map.get(url) ?? null;
  }
  async put(url: string, entry: CachedDirectory): Promise<void> {
    this.map.set(url, entry);
  }
  async getFailure(origin: string): Promise<number | null> {
    return this.failures.get(origin) ?? null;
  }
  async putFailure(origin: string, untilMs: number): Promise<void> {
    this.failures.set(origin, untilMs);
  }
}

/** KV: directories under "wba:dir:<url>" and failures under "wba:fail:<origin>", each with its own TTL. Needs the Worker runtime. */
export class KvKeyCache implements KeyCache {
  constructor(private readonly kv: KVNamespace) {}
  async get(url: string): Promise<CachedDirectory | null> {
    const v = await this.kv.get(`wba:dir:${url}`, "json");
    return (v as CachedDirectory | null) ?? null;
  }
  async put(url: string, entry: CachedDirectory): Promise<void> {
    const ttl = Math.max(60, Math.floor((entry.expires_at - Date.now()) / 1000));
    await this.kv.put(`wba:dir:${url}`, JSON.stringify(entry), { expirationTtl: ttl });
  }
  async getFailure(origin: string): Promise<number | null> {
    const v = await this.kv.get(`wba:fail:${origin}`);
    return v === null ? null : Number(v);
  }
  async putFailure(origin: string, untilMs: number): Promise<void> {
    await this.kv.put(`wba:fail:${origin}`, String(untilMs), { expirationTtl: Math.max(60, Math.ceil((untilMs - Date.now()) / 1000)) });
  }
}

// ---------------------------------------------------------------- nonces

export interface NonceStore {
  /** Record the nonce; false when it was already seen inside the window. Must be atomic: two claims of one nonce, one true. */
  claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  /** Has this nonce been claimed and not yet expired? A cheap check before any key is fetched; never a substitute for claim. */
  seen(key: string, nowMs: number): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  readonly entries = new Map<string, number>();
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [k, exp] of this.entries) if (exp <= nowMs) this.entries.delete(k);
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAtMs);
    return true;
  }
  async seen(key: string, nowMs: number): Promise<boolean> {
    const exp = this.entries.get(key);
    return exp !== undefined && exp > nowMs;
  }
}

/**
 * KV fallback, NOT atomic: KV is eventually consistent and a get then put can
 * race, so two requests with the same nonce at the same moment can both pass.
 * Production uses the NonceDO Durable Object (src/readers/nonce-do.ts,
 * binding NONCES); this store is kept only for a deployment without it.
 */
export class KvNonceStore implements NonceStore {
  constructor(private readonly kv: KVNamespace) {}
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const k = `wba:nonce:${key}`;
    if ((await this.kv.get(k)) !== null) return false;
    await this.kv.put(k, "1", { expirationTtl: Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1000)) });
    return true;
  }
  async seen(key: string): Promise<boolean> {
    return (await this.kv.get(`wba:nonce:${key}`)) !== null;
  }
}

// ---------------------------------------------------------------- receipts

export interface ReceiptRow {
  id: string;
  trooth_id: string;
  version: number | null;
  page_id: string | null;
  representation: string;
  agent_key_url: string | null;
  keyid: string | null;
  proof: "web_bot_auth" | "none";
  read_at: string;
  ip_hash: string;
  /** How many reads this row stands for: receipts are counted per minute and written once a minute (src/readers/rate-limit.ts). Absent means 1. */
  count?: number;
}

export interface ReceiptStore {
  put(r: ReceiptRow): Promise<void>;
  /** Receipts for a company between two ISO instants, [from, to). */
  list(troothId: string, fromIso: string, toIso: string): Promise<ReceiptRow[]>;
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly rows: ReceiptRow[] = [];
  async put(r: ReceiptRow): Promise<void> {
    this.rows.push(r);
  }
  async list(troothId: string, fromIso: string, toIso: string): Promise<ReceiptRow[]> {
    return this.rows.filter((r) => r.trooth_id === troothId && r.read_at >= fromIso && r.read_at < toIso);
  }
}

/** D1 skeleton over semanto_read_receipts (migrations/0001_semanto.sql). */
export class D1ReceiptStore implements ReceiptStore {
  constructor(private readonly db: D1Database) {}
  async put(r: ReceiptRow): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash, count, minute) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
      .bind(r.id, r.trooth_id, r.version, r.page_id, r.representation, r.agent_key_url, r.keyid, r.proof, r.read_at, r.ip_hash, r.count ?? 1, r.read_at.slice(0, 16))
      .run();
  }
  /** Many rows in one D1 batch (the per-minute flush of src/readers/rate-limit.ts); a row already written for the same minute gets the counts added. */
  async putMany(rows: ReceiptRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 50) {
      await this.db.batch(
        rows.slice(i, i + 50).map((r) =>
          this.db
            .prepare(
              "INSERT INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash, count, minute) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(id) DO UPDATE SET count = count + excluded.count",
            )
            .bind(r.id, r.trooth_id, r.version, r.page_id, r.representation, r.agent_key_url, r.keyid, r.proof, r.read_at, r.ip_hash, r.count ?? 1, r.read_at.slice(0, 16)),
        ),
      );
    }
  }
  async list(troothId: string, fromIso: string, toIso: string): Promise<ReceiptRow[]> {
    const res = await this.db
      .prepare("SELECT id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid AS keyid, proof, read_at, ip_hash, count FROM semanto_read_receipts WHERE trooth_id = ?1 AND read_at >= ?2 AND read_at < ?3 ORDER BY read_at")
      .bind(troothId, fromIso, toIso)
      .all<ReceiptRow>();
    return res.results;
  }
}
