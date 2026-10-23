// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// D1 access for the app, one function per query and no SQL anywhere else,
// the rule the Semanto Worker's src/db follows. Tables are in
// migrations/0001_shopify_app.sql. deleteShopData removes every row the app
// holds for a shop in one batch: uninstall and shop/redact both end there.

export type ConnState = "none" | "pending" | "connected";
export type EmbedState = "unknown" | "active" | "inactive" | "skipped";

export interface ShopRow {
  shop: string;
  installed_at: string;
  welcome_done: number;
  conn_state: ConnState;
  trooth_id: string | null;
  kid: string | null;
  public_jwk: string | null;
  private_jwk_sealed: string | null;
  session_id: string | null;
  poll_token_sealed: string | null;
  approve_url: string | null;
  session_expires_at: string | null;
  connected_at: string | null;
  last_denied_at: string | null;
  embed_state: EmbedState;
  embed_checked_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export type StepState = "waiting" | "running" | "done" | "failed";
export interface SyncStep {
  key: "read" | "prepare" | "send" | "receipt";
  state: StepState;
  detail: string;
}

export interface SyncRunRow {
  id: string;
  shop: string;
  kind: "first" | "manual" | "webhook";
  state: "running" | "done" | "failed";
  bulk_operation_id: string | null;
  steps: SyncStep[];
  products: number;
  records: number;
  offers: number;
  skipped: number;
  signed: boolean | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

type RawRun = Omit<SyncRunRow, "steps" | "signed"> & { steps: string; signed: number | null };

const SHOP_COLUMNS = new Set<keyof ShopRow>([
  "welcome_done",
  "conn_state",
  "trooth_id",
  "kid",
  "public_jwk",
  "private_jwk_sealed",
  "session_id",
  "poll_token_sealed",
  "approve_url",
  "session_expires_at",
  "connected_at",
  "last_denied_at",
  "embed_state",
  "embed_checked_at",
  "last_sync_at",
  "last_error",
]);

const RUN_COLUMNS = new Set<string>(["state", "bulk_operation_id", "steps", "products", "records", "offers", "skipped", "signed", "error", "finished_at"]);

function toRun(r: RawRun): SyncRunRow {
  return { ...r, steps: JSON.parse(r.steps) as SyncStep[], signed: r.signed === null ? null : r.signed === 1 };
}

export class AppStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  // ------------------------------------------------------------ shops

  async ensureShop(shop: string): Promise<ShopRow> {
    const at = this.iso();
    await this.db.prepare("INSERT OR IGNORE INTO shops (shop, installed_at, updated_at) VALUES (?, ?, ?)").bind(shop, at, at).run();
    return (await this.getShop(shop))!;
  }

  async getShop(shop: string): Promise<ShopRow | null> {
    return this.db.prepare("SELECT * FROM shops WHERE shop = ?").bind(shop).first<ShopRow>();
  }

  async updateShop(shop: string, patch: Partial<ShopRow>): Promise<void> {
    const keys = Object.keys(patch).filter((k): k is keyof ShopRow => SHOP_COLUMNS.has(k as keyof ShopRow));
    if (!keys.length) return;
    const sql = `UPDATE shops SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE shop = ?`;
    await this.db.prepare(sql).bind(...keys.map((k) => patch[k] ?? null), this.iso(), shop).run();
  }

  /** Every row for the shop, in every table, in one transaction. */
  async deleteShopData(shop: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM shopify_sessions WHERE shop = ?").bind(shop),
      this.db.prepare("DELETE FROM products WHERE shop = ?").bind(shop),
      this.db.prepare("DELETE FROM sync_runs WHERE shop = ?").bind(shop),
      this.db.prepare("DELETE FROM webhook_events WHERE shop = ?").bind(shop),
      this.db.prepare("DELETE FROM app_events WHERE shop = ?").bind(shop),
      this.db.prepare("DELETE FROM shops WHERE shop = ?").bind(shop),
    ]);
  }

  /** How many rows the app holds for a shop, across every table (the tests use it to prove nothing is left). */
  async rowCount(shop: string): Promise<number> {
    let n = 0;
    for (const t of ["shopify_sessions", "products", "sync_runs", "webhook_events", "app_events", "shops"]) {
      const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE shop = ?`).bind(shop).first<{ n: number }>();
      n += r?.n ?? 0;
    }
    return n;
  }

  // ------------------------------------------------------------ sync runs

  /**
   * Start a run, unless a first or manual sync is already running for the shop (the partial unique index
   * sync_runs_one_running, migration 0002): then that running run is answered instead of a second one.
   */
  async createRun(run: Pick<SyncRunRow, "id" | "shop" | "kind" | "steps">): Promise<{ run: SyncRunRow; created: boolean }> {
    const inserted = await this.db
      .prepare("INSERT INTO sync_runs (id, shop, kind, state, steps, started_at) VALUES (?, ?, ?, 'running', ?, ?) ON CONFLICT DO NOTHING RETURNING id")
      .bind(run.id, run.shop, run.kind, JSON.stringify(run.steps), this.iso())
      .first<{ id: string }>();
    if (inserted) return { run: (await this.getRun(run.id))!, created: true };
    return { run: (await this.runningRun(run.shop))!, created: false };
  }

  async getRun(id: string): Promise<SyncRunRow | null> {
    const r = await this.db.prepare("SELECT * FROM sync_runs WHERE id = ?").bind(id).first<RawRun>();
    return r ? toRun(r) : null;
  }

  async runByBulkId(bulkId: string): Promise<SyncRunRow | null> {
    const r = await this.db.prepare("SELECT * FROM sync_runs WHERE bulk_operation_id = ?").bind(bulkId).first<RawRun>();
    return r ? toRun(r) : null;
  }

  async latestRun(shop: string, kinds: SyncRunRow["kind"][] = ["first", "manual"]): Promise<SyncRunRow | null> {
    const r = await this.db
      .prepare(`SELECT * FROM sync_runs WHERE shop = ? AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .bind(shop, ...kinds)
      .first<RawRun>();
    return r ? toRun(r) : null;
  }

  async runningRun(shop: string): Promise<SyncRunRow | null> {
    const r = await this.db.prepare("SELECT * FROM sync_runs WHERE shop = ? AND state = 'running' AND kind IN ('first', 'manual') ORDER BY started_at DESC LIMIT 1").bind(shop).first<RawRun>();
    return r ? toRun(r) : null;
  }

  async updateRun(id: string, patch: Partial<SyncRunRow>): Promise<void> {
    const entries = Object.entries(patch).filter(([k]) => RUN_COLUMNS.has(k));
    if (!entries.length) return;
    const values = entries.map(([k, v]) => (k === "steps" ? JSON.stringify(v) : k === "signed" ? (v === null ? null : v ? 1 : 0) : (v ?? null)));
    await this.db.prepare(`UPDATE sync_runs SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...(values as (string | number | null)[]), id).run();
  }

  /** Keep the newest 20 runs per shop; older ones are removed when a new run starts (no cron). */
  async pruneRuns(shop: string): Promise<void> {
    await this.db.prepare("DELETE FROM sync_runs WHERE shop = ? AND id NOT IN (SELECT id FROM sync_runs WHERE shop = ? ORDER BY started_at DESC LIMIT 20)").bind(shop, shop).run();
  }

  // ------------------------------------------------------------ product snapshots

  async getProduct(shop: string, productId: string): Promise<{ hash: string; doc: string } | null> {
    return this.db.prepare("SELECT hash, doc FROM products WHERE shop = ? AND product_id = ?").bind(shop, productId).first<{ hash: string; doc: string }>();
  }

  async putProduct(shop: string, productId: string, hash: string, doc: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO products (shop, product_id, hash, doc, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (shop, product_id) DO UPDATE SET hash = excluded.hash, doc = excluded.doc, updated_at = excluded.updated_at")
      .bind(shop, productId, hash, doc, this.iso())
      .run();
  }

  async deleteProduct(shop: string, productId: string): Promise<void> {
    await this.db.prepare("DELETE FROM products WHERE shop = ? AND product_id = ?").bind(shop, productId).run();
  }

  async productIds(shop: string): Promise<string[]> {
    const r = await this.db.prepare("SELECT product_id FROM products WHERE shop = ?").bind(shop).all<{ product_id: string }>();
    return r.results.map((x) => x.product_id);
  }

  // ------------------------------------------------------------ webhooks and events

  /**
   * Record a webhook delivery id once, in one conditional write; false when it was already handled (Shopify may deliver
   * a webhook more than once, and two deliveries can arrive at the same moment: only one of them claims the id).
   */
  async claimWebhook(id: string, shop: string, topic: string): Promise<boolean> {
    const at = this.now();
    const claimed = await this.db.prepare("INSERT INTO webhook_events (id, shop, topic, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id").bind(id, shop, topic, at.toISOString()).first<{ id: string }>();
    // Ids older than seven days are removed as new ones arrive; Shopify retries a delivery for at most 48 hours.
    await this.db.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(new Date(at.getTime() - 7 * 86400000).toISOString()).run();
    return claimed !== null;
  }

  /** Give a claimed delivery id back when its work could not be queued, so Shopify's retry of it is handled. */
  async releaseWebhook(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM webhook_events WHERE id = ?").bind(id).run();
  }

  /**
   * Move a shop to pending only from none, in one conditional write: of two Connect presses at once, one opens the
   * session and the other reads it, so no second key or session is made behind the merchant's back.
   */
  async beginPending(shop: string, patch: Partial<ShopRow>): Promise<boolean> {
    const keys = Object.keys(patch).filter((k): k is keyof ShopRow => SHOP_COLUMNS.has(k as keyof ShopRow) && k !== "conn_state");
    const sql = `UPDATE shops SET conn_state = 'pending', ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE shop = ? AND conn_state = 'none' RETURNING shop`;
    return (await this.db.prepare(sql).bind(...keys.map((k) => patch[k] ?? null), this.iso(), shop).first<{ shop: string }>()) !== null;
  }

  /** Move a pending shop holding this key to connected, once: of two checks that both saw the approval, one finalizes. */
  async finalizePending(shop: string, kid: string, patch: Partial<ShopRow>): Promise<boolean> {
    const keys = Object.keys(patch).filter((k): k is keyof ShopRow => SHOP_COLUMNS.has(k as keyof ShopRow) && k !== "conn_state");
    const sql = `UPDATE shops SET conn_state = 'connected', ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE shop = ? AND conn_state = 'pending' AND kid = ? RETURNING shop`;
    return (await this.db.prepare(sql).bind(...keys.map((k) => patch[k] ?? null), this.iso(), shop, kid).first<{ shop: string }>()) !== null;
  }

  /** The activity list keeps the newest 200 events per shop; older ones are removed as new ones arrive (no cron). */
  async logEvent(shop: string, action: string, detail?: string): Promise<void> {
    await this.db.prepare("INSERT INTO app_events (shop, action, detail, at) VALUES (?, ?, ?, ?)").bind(shop, action, detail ?? null, this.iso()).run();
    await this.db.prepare("DELETE FROM app_events WHERE shop = ? AND id NOT IN (SELECT id FROM app_events WHERE shop = ? ORDER BY id DESC LIMIT 200)").bind(shop, shop).run();
  }

  async events(shop: string, limit = 20): Promise<{ action: string; detail: string | null; at: string }[]> {
    const r = await this.db.prepare("SELECT action, detail, at FROM app_events WHERE shop = ? ORDER BY id DESC LIMIT ?").bind(shop, limit).all<{ action: string; detail: string | null; at: string }>();
    return r.results;
  }
}
