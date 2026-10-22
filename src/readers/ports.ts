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
}

export interface HttpPort {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
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

export function platformHttp(f: typeof fetch = fetch): HttpPort {
  return {
    async get(url, headers = {}) {
      const res = await f(url, { method: "GET", headers, redirect: "manual" });
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        h[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: h, body: await res.text() };
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
}

export class MemoryKeyCache implements KeyCache {
  readonly map = new Map<string, CachedDirectory>();
  async get(url: string): Promise<CachedDirectory | null> {
    return this.map.get(url) ?? null;
  }
  async put(url: string, entry: CachedDirectory): Promise<void> {
    this.map.set(url, entry);
  }
}

/** KV skeleton: keys under "wba:dir:<url>", TTL from the entry. Needs the Worker runtime. */
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
}

// ---------------------------------------------------------------- nonces

export interface NonceStore {
  /** Record the nonce; false when it was already seen inside the window. */
  claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  readonly seen = new Map<string, number>();
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }
}

/** KV skeleton: a nonce key lives until the signature's own expiry. KV is eventually consistent; a Durable Object is the exact version. */
export class KvNonceStore implements NonceStore {
  constructor(private readonly kv: KVNamespace) {}
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const k = `wba:nonce:${key}`;
    if ((await this.kv.get(k)) !== null) return false;
    await this.kv.put(k, "1", { expirationTtl: Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1000)) });
    return true;
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
      .prepare("INSERT OR IGNORE INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
      .bind(r.id, r.trooth_id, r.version, r.page_id, r.representation, r.agent_key_url, r.keyid, r.proof, r.read_at, r.ip_hash)
      .run();
  }
  async list(troothId: string, fromIso: string, toIso: string): Promise<ReceiptRow[]> {
    const res = await this.db
      .prepare("SELECT id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid AS keyid, proof, read_at, ip_hash FROM semanto_read_receipts WHERE trooth_id = ?1 AND read_at >= ?2 AND read_at < ?3 ORDER BY read_at")
      .bind(troothId, fromIso, toIso)
      .all<ReceiptRow>();
    return res.results;
  }
}
