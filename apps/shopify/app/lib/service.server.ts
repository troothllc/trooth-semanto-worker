// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Everything the app does for a shop, behind the screens, the webhooks and the
// queue: the connection to Trooth (app/lib/onboarding.ts decides, this module
// carries out the effects), the app embed state, the first sync and Sync now
// (one bulk operation, finished by the bulk_operations/finish webhook), the
// incremental product updates, Disconnect, uninstall and shop/redact.
//
// No cron and no background polling: the connect session is checked only when
// the merchant's Connect screen asks (every two seconds, until it expires), a
// sync's progress is read only when the merchant's screen asks, and every
// other piece of work starts from a merchant action or a Shopify webhook.

import { BULK_PRODUCTS_QUERY, lines, readBulkProducts, type BulkReadResult } from "./bulk";
import { EMBED_BLOCK_HANDLE, type Settings, type SyncJob } from "./env";
import { catalogDocument, chunkProducts, CHUNK_MAX_BYTES, legacyId, mapProduct, markDiscontinued, productHash, type CatalogProduct, type ShopInfo } from "./mapping";
import { connectTransition, currentStep, embedDeepLink, stepStatuses, type ConnectEvent, type Connection, type Effect, type OnboardingInput, type Step, type SyncView } from "./onboarding";
import { RetryExhausted, withRetry } from "./retry";
import { open, seal } from "./seal";
import { generateConnectorKey, publicOf, type ConnectorPrivateJwk } from "./sign";
import { bulkStatus, clearEmbedMetafields, productById, setEmbedMetafields, shopInfo, startBulkProducts, ShopifyGraphqlError, type Gql } from "./shopify-admin";
import type { AppStore, EmbedState, ShopRow, SyncRunRow, SyncStep } from "./store.server";
import { RevokeRefused, TroothError, type CatalogReceipt, type Fetch, type RevokeReason, type TroothClient } from "./trooth-client";

export interface ServiceDeps {
  store: AppStore;
  trooth: TroothClient;
  settings: Settings;
  enqueue: (job: SyncJob) => Promise<void>;
  /** An Admin GraphQL client for a shop from its offline session (shopify.unauthenticated.admin). */
  gqlFor: (shop: string) => Promise<Gql>;
  /** Fetch for the bulk result file (a signed Shopify storage address, no credentials). */
  fetchFile?: Fetch;
  now?: () => Date;
  newId?: () => string;
}

export interface OnboardingView {
  shop: string;
  step: Step;
  statuses: ReturnType<typeof stepStatuses>;
  connection: Connection;
  embed: EmbedState;
  embedLink: string;
  sync: SyncView;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Set when Trooth refused the last revocation (401 or 403): Trooth still holds the key. */
  revokeError: string | null;
  dashboardUrl: string;
  troothProfileUrl: string | null;
}

export class ConflictError extends Error {}

const FRESH_STEPS = (): SyncStep[] => [
  { key: "read", state: "running", detail: "Asking Shopify for your active products" },
  { key: "prepare", state: "waiting", detail: "" },
  { key: "send", state: "waiting", detail: "" },
  { key: "receipt", state: "waiting", detail: "" },
];

function setStep(steps: SyncStep[], key: SyncStep["key"], state: SyncStep["state"], detail: string): SyncStep[] {
  return steps.map((s) => (s.key === key ? { key, state, detail } : s));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export class ShopService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------ reading state

  connectionOf(row: ShopRow): Connection {
    if (row.conn_state === "connected" && row.trooth_id && row.kid) return { state: "connected", troothId: row.trooth_id, kid: row.kid, connectedAt: row.connected_at ?? row.updated_at };
    if (row.conn_state === "pending" && row.session_id && row.approve_url && row.session_expires_at) return { state: "pending", sessionId: row.session_id, approveUrl: row.approve_url, expiresAt: row.session_expires_at };
    return { state: "none", reason: row.last_denied_at && row.conn_state === "none" ? "denied" : null };
  }

  async syncView(shop: string): Promise<SyncView> {
    const run = await this.d.store.latestRun(shop);
    if (!run) return { state: "never" };
    if (run.state === "running") return { state: "running", run };
    if (run.state === "done") return { state: "done", run };
    return { state: "failed", run };
  }

  /** The onboarding and settings view; reconciles an expired pending connection first. */
  async view(shop: string): Promise<OnboardingView> {
    await this.d.store.ensureShop(shop);
    await this.reconcile(shop);
    const row = (await this.d.store.getShop(shop))!;
    const connection = this.connectionOf(row);
    const sync = await this.syncView(shop);
    const input: OnboardingInput = { welcomeDone: row.welcome_done === 1, connection, embed: row.embed_state, sync };
    return {
      shop,
      step: currentStep(input),
      statuses: stepStatuses(input),
      connection,
      embed: row.embed_state,
      embedLink: embedDeepLink(shop, this.d.settings.apiKey, EMBED_BLOCK_HANDLE),
      sync,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      revokeError: (await this.d.store.events(shop, 1))[0]?.action === "revoke_refused" ? row.last_error : null,
      dashboardUrl: this.d.settings.dashboardUrl,
      troothProfileUrl: connection.state === "connected" ? `${this.d.settings.dashboardUrl}?company=${encodeURIComponent(connection.troothId)}` : null,
    };
  }

  async markWelcomeDone(shop: string): Promise<void> {
    await this.d.store.ensureShop(shop);
    await this.d.store.updateShop(shop, { welcome_done: 1 });
  }

  // ------------------------------------------------------------ the connection

  private async apply(shop: string, row: ShopRow, event: ConnectEvent): Promise<{ row: ShopRow; effects: Effect[] }> {
    const t = connectTransition(this.connectionOf(row), event, this.now());
    return { row, effects: t.effects };
  }

  /**
   * Connect to Trooth: make the shop's key and a connect session, or hand back
   * the pending one. The key is kept only after Trooth has answered with a
   * session, so a failed start leaves nothing stored.
   */
  async connect(shop: string): Promise<{ approveUrl: string; expiresAt: string }> {
    const row = await this.d.store.ensureShop(shop);
    const { effects } = await this.apply(shop, row, { type: "connect_clicked" });
    if (effects.includes("discard_pending")) await this.discardPending(shop, row);
    if (effects.includes("open_approve_window")) return { approveUrl: row.approve_url!, expiresAt: row.session_expires_at! };
    if (!effects.includes("create_session")) throw new ConflictError("This store is already connected to Trooth.");
    const { privateJwk } = await generateConnectorKey();
    const returnUrl = `https://${shop}/admin/apps/${this.d.settings.appHandle}`;
    const session = await this.d.trooth.createConnectSession(shop, publicOf(privateJwk), returnUrl);
    // Pending only from none, in one conditional write: a second Connect press at the same moment hands back the
    // session the first one opened (the one whose window the merchant sees); this request's session is never shown,
    // so nobody can approve it, and it expires at Trooth with its key unregistered.
    const begun = await this.d.store.beginPending(shop, {
      kid: privateJwk.kid,
      public_jwk: JSON.stringify(publicOf(privateJwk)),
      private_jwk_sealed: await seal(JSON.stringify(privateJwk), "connector-key", this.d.settings.sealKey),
      session_id: session.session_id,
      poll_token_sealed: await seal(session.poll_token, "poll-token", this.d.settings.sealKey),
      approve_url: session.approve_url,
      session_expires_at: session.expires_at,
      last_denied_at: null,
      last_error: null,
    });
    if (!begun) {
      const now = (await this.d.store.getShop(shop))!;
      if (now.conn_state === "pending" && now.approve_url && now.session_expires_at) return { approveUrl: now.approve_url, expiresAt: now.session_expires_at };
      throw new ConflictError("This store is already connected to Trooth.");
    }
    await this.d.store.logEvent(shop, "connect_started", `session ${session.session_id}, key ${privateJwk.kid}`);
    return { approveUrl: session.approve_url, expiresAt: session.expires_at };
  }

  /** One check of the pending session; the Connect screen calls it every two seconds. */
  async poll(shop: string): Promise<Connection> {
    const row = await this.d.store.ensureShop(shop);
    if (row.conn_state !== "pending" || !row.session_id || !row.poll_token_sealed) return this.connectionOf(row);
    const token = await open(row.poll_token_sealed, "poll-token", this.d.settings.sealKey);
    let result: Awaited<ReturnType<TroothClient["pollConnectSession"]>>;
    try {
      result = await this.d.trooth.pollConnectSession(row.session_id, token);
    } catch (e) {
      // Trooth's public connect routes share a per-address rate limit (public_connect); a 429 is not a failure of the
      // connection, so the screen stays pending and checks again on its next tick. The expiry still ends the wait.
      if (e instanceof TroothError && e.status === 429 && this.now().getTime() < Date.parse(row.session_expires_at ?? "")) return this.connectionOf(row);
      throw e;
    }
    const t = connectTransition(this.connectionOf(row), { type: "poll", result }, this.now());
    if (t.effects.includes("finalize") && result.state === "approved") await this.finalize(shop, result.trooth_id, result.kid);
    if (t.effects.includes("discard_pending")) {
      await this.discardPending(shop, row);
      if (t.next.state === "none" && t.next.reason === "denied") await this.d.store.updateShop(shop, { last_denied_at: this.now().toISOString() });
      await this.d.store.logEvent(shop, t.next.state === "none" && t.next.reason === "denied" ? "connect_denied" : "connect_expired");
    }
    const after = (await this.d.store.getShop(shop))!;
    const c = this.connectionOf(after);
    return c.state === "none" && t.next.state === "none" ? { state: "none", reason: t.next.reason } : c;
  }

  /**
   * A pending connection whose session has expired is settled when anything
   * next reads the shop (no sweep): one last check with Trooth, so an approval
   * that landed after the merchant closed the screen is kept, and anything
   * else removes the pending key.
   */
  async reconcile(shop: string): Promise<void> {
    const row = await this.d.store.getShop(shop);
    if (!row || row.conn_state !== "pending" || !row.session_expires_at) return;
    if (this.now().getTime() < Date.parse(row.session_expires_at)) return;
    try {
      await this.poll(shop);
    } catch {
      // Trooth could not be asked. The session has expired, so the merchant can only start again; the key is
      // revoked (Trooth answers not registered unless it was approved) and removed.
      await this.discardPending(shop, row);
      await this.d.store.logEvent(shop, "connect_abandoned");
    }
  }

  /**
   * Remove the pending key and session. With the row, the key is first offered
   * to Trooth for revocation, best effort: Trooth refuses a key it never
   * registered (the usual case), and revokes one that an approval registered
   * in a race with the expiry, so no registered key is ever left without its
   * private half.
   */
  private async discardPending(shop: string, row?: ShopRow): Promise<void> {
    const key = row ? await this.keyOf(row) : null;
    if (key) {
      try {
        await this.revokeAndRecord(shop, key, null, "disconnected");
      } catch (e) {
        // A refusal is recorded as an error by revokeAndRecord; a network failure leaves a key Trooth never registered
        // in the usual case, so the pending state is cleared either way.
        if (!(e instanceof RevokeRefused)) await this.d.store.logEvent(shop, "revoke_unreachable", e instanceof Error ? e.message : String(e));
      }
    }
    await this.d.store.updateShop(shop, {
      conn_state: "none",
      kid: null,
      public_jwk: null,
      private_jwk_sealed: null,
      session_id: null,
      poll_token_sealed: null,
      approve_url: null,
      session_expires_at: null,
    });
  }

  private async finalize(shop: string, troothId: string, kid: string): Promise<void> {
    const row = (await this.d.store.getShop(shop))!;
    if (row.kid !== kid) {
      // Trooth approved a key this shop does not hold; refuse it rather than sign with the wrong key.
      await this.discardPending(shop);
      await this.d.store.updateShop(shop, { last_error: "Trooth approved a different key than this store made. Connect again." });
      return;
    }
    // Once: of two checks that both saw the approval (a slow answer overlapping the next two-second check), one
    // finalizes and starts the first sync; the other sees the shop connected and does nothing more.
    const won = await this.d.store.finalizePending(shop, kid, {
      trooth_id: troothId,
      connected_at: this.now().toISOString(),
      session_id: null,
      poll_token_sealed: null,
      approve_url: null,
      session_expires_at: null,
      last_error: null,
    });
    if (!won) return;
    await this.d.store.logEvent(shop, "connected", `trooth_id ${troothId}, key ${kid}`);
    await this.writeEmbedValues(shop, troothId);
    await this.startSync(shop, "first").catch(async (e) => {
      await this.d.store.updateShop(shop, { last_error: e instanceof Error ? e.message : String(e) });
    });
  }

  private async writeEmbedValues(shop: string, troothId: string): Promise<void> {
    try {
      await setEmbedMetafields(await this.d.gqlFor(shop), { trooth_id: troothId, api_base: this.d.settings.troothApiBase });
    } catch (e) {
      await this.d.store.updateShop(shop, { last_error: `The app embed values were not saved: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /**
   * Revoke at Trooth and record the outcome in the shop's activity, three ways
   * apart: revoked; never registered (404 not_registered, nothing to revoke);
   * refused (401 bad signature, 403 not this app's key), which is an error the
   * settings page shows, because Trooth still holds that key.
   */
  private async revokeAndRecord(shop: string, key: ConnectorPrivateJwk, troothId: string | null, reason: RevokeReason): Promise<"revoked" | "not_registered"> {
    try {
      const outcome = await this.d.trooth.revoke(shop, key, troothId, reason);
      await this.d.store.logEvent(shop, outcome === "revoked" ? "key_revoked" : "key_not_registered", `key ${key.kid}, reason ${reason}`);
      return outcome;
    } catch (e) {
      if (e instanceof RevokeRefused) {
        const message = `Trooth refused to revoke this store's key ${key.kid} (answer ${e.status}: ${e.message}). Trooth still holds it; revoke it in the Semanto dashboard under Connectors.`;
        await this.d.store.logEvent(shop, "revoke_refused", message);
        await this.d.store.updateShop(shop, { last_error: message });
      }
      throw e;
    }
  }

  private async keyOf(row: ShopRow): Promise<ConnectorPrivateJwk | null> {
    if (!row.private_jwk_sealed) return null;
    try {
      return JSON.parse(await open(row.private_jwk_sealed, "connector-key", this.d.settings.sealKey)) as ConnectorPrivateJwk;
    } catch {
      return null;
    }
  }

  /** Disconnect from the settings page: revoke the key at Trooth, clear the embed values, keep the app installed. */
  async disconnect(shop: string): Promise<"revoked" | "not_registered" | "nothing"> {
    const row = await this.d.store.ensureShop(shop);
    const t = connectTransition(this.connectionOf(row), { type: "disconnect" }, this.now());
    if (!t.effects.length) return "nothing";
    const key = await this.keyOf(row);
    let outcome: "revoked" | "not_registered" | "nothing" = "nothing";
    if (key && t.effects.includes("revoke_key")) {
      try {
        outcome = await this.revokeAndRecord(shop, key, row.trooth_id, "disconnected");
      } catch (e) {
        // Refused: the connection is kept as it is and the settings page shows the error; nothing is silently dropped.
        if (e instanceof RevokeRefused) throw new ConflictError((await this.d.store.getShop(shop))!.last_error ?? e.message);
        throw e;
      }
    }
    if (t.effects.includes("clear_embed_values")) await clearEmbedMetafields(await this.d.gqlFor(shop)).catch(() => undefined);
    await this.discardPending(shop);
    await this.d.store.updateShop(shop, { trooth_id: null, connected_at: null, last_error: null });
    await this.d.store.logEvent(shop, "disconnected");
    return outcome;
  }

  /**
   * app/uninstalled and shop/redact: revoke the key at Trooth when one is held,
   * then delete every row for the shop. `final` is true on the queue's last
   * attempt: the rows are deleted even if Trooth could not be reached, because
   * the private key goes with them and nothing can sign with it again.
   */
  async removeShop(shop: string, reason: "uninstalled" | "shop_redact", final: boolean): Promise<void> {
    const row = await this.d.store.getShop(shop);
    if (row) {
      const t = connectTransition(this.connectionOf(row), { type: "uninstall" }, this.now());
      const key = await this.keyOf(row);
      if (key && t.effects.includes("revoke_key")) {
        try {
          const outcome = await this.d.trooth.revoke(shop, key, row.trooth_id, reason);
          console.log(JSON.stringify({ at: this.now().toISOString(), event: outcome === "revoked" ? "key_revoked" : "key_not_registered", shop, kid: key.kid, reason }));
        } catch (e) {
          if (e instanceof RevokeRefused) {
            // The shop's rows must go (uninstall, shop/redact), so the refusal is logged as an error for Trooth's operators.
            console.error(JSON.stringify({ at: this.now().toISOString(), event: "revoke_refused", shop, kid: key.kid, reason, status: e.status, code: e.code, detail: e.message }));
          } else if (!final) throw e;
        }
      }
    }
    await this.d.store.deleteShopData(shop);
  }

  // ------------------------------------------------------------ the app embed

  async reportEmbed(shop: string, state: "active" | "inactive" | "skipped"): Promise<void> {
    await this.d.store.ensureShop(shop);
    const row = (await this.d.store.getShop(shop))!;
    // A merchant who skipped keeps "skipped" until the embed is actually on.
    const next: EmbedState = state === "inactive" && row.embed_state === "skipped" ? "skipped" : state;
    await this.d.store.updateShop(shop, { embed_state: next, embed_checked_at: this.now().toISOString() });
    if (state === "active" && row.trooth_id) await this.writeEmbedValues(shop, row.trooth_id);
  }

  // ------------------------------------------------------------ sync

  /** Start a full sync: one bulk operation; the bulk_operations/finish webhook continues it. One running sync per shop. */
  async startSync(shop: string, kind: "first" | "manual"): Promise<SyncRunRow> {
    const row = await this.d.store.getShop(shop);
    if (!row || row.conn_state !== "connected" || !row.trooth_id) throw new ConflictError("Connect this store to Trooth before syncing.");
    const running = await this.d.store.runningRun(shop);
    if (running) return running;
    await this.d.store.pruneRuns(shop);
    const created = await this.d.store.createRun({ id: this.newId(), shop, kind, steps: FRESH_STEPS() });
    // Another press (or the first sync after approval) started one a moment ago: that run is the answer, and no second
    // bulk operation is asked of Shopify (it allows one at a time and would fail the run the screen shows).
    if (!created.created) return created.run;
    const run = created.run;
    try {
      const bulkId = await startBulkProducts(await this.d.gqlFor(shop), BULK_PRODUCTS_QUERY);
      await this.d.store.updateRun(run.id, { bulk_operation_id: bulkId, steps: setStep(run.steps, "read", "running", "Shopify is gathering your products") });
      await this.d.store.logEvent(shop, kind === "first" ? "first_sync_started" : "sync_started", bulkId);
    } catch (e) {
      const msg = e instanceof ShopifyGraphqlError && e.retryable ? "Shopify is already exporting products for another app. Try Sync now again in a few minutes." : `Shopify did not start the product export: ${e instanceof Error ? e.message : String(e)}`;
      await this.failRun(shop, run.id, setStep(run.steps, "read", "failed", msg), msg);
    }
    return (await this.d.store.getRun(run.id))!;
  }

  /** Called while the merchant watches the sync step: reads the bulk operation's progress (on demand, never in the background). */
  async refreshProgress(shop: string): Promise<SyncView> {
    const view = await this.syncView(shop);
    if (view.state !== "running" || !view.run.bulk_operation_id) return view;
    const read = view.run.steps.find((s) => s.key === "read");
    if (read?.state !== "running") return view;
    try {
      const st = await bulkStatus(await this.d.gqlFor(shop), view.run.bulk_operation_id);
      if (st && (st.status === "RUNNING" || st.status === "CREATED")) {
        await this.d.store.updateRun(view.run.id, { steps: setStep(view.run.steps, "read", "running", st.objectCount ? `${plural(st.objectCount, "item", "items")} read so far` : "Shopify is gathering your products") });
      }
      if (st && st.status === "COMPLETED") await this.d.enqueue({ kind: "bulk_finished", shop, bulk_operation_id: st.id });
      if (st && (st.status === "FAILED" || st.status === "CANCELED" || st.status === "EXPIRED")) {
        const msg = `Shopify stopped the product export (${(st.errorCode ?? st.status).toLowerCase()}). Press Sync now to try again.`;
        await this.failRun(shop, view.run.id, setStep(view.run.steps, "read", "failed", msg), msg);
      }
    } catch {
      // Progress is a courtesy; the webhook finishes the run either way.
    }
    return this.syncView(shop);
  }

  private async failRun(shop: string, runId: string, steps: SyncStep[], message: string): Promise<void> {
    await this.d.store.updateRun(runId, { state: "failed", steps, error: message, finished_at: this.now().toISOString() });
    await this.d.store.updateShop(shop, { last_error: message });
    await this.d.store.logEvent(shop, "sync_failed", message);
  }

  private async keyAndTrooth(shop: string): Promise<{ row: ShopRow; key: ConnectorPrivateJwk; troothId: string } | null> {
    const row = await this.d.store.getShop(shop);
    if (!row || row.conn_state !== "connected" || !row.trooth_id) return null;
    const key = await this.keyOf(row);
    return key ? { row, key, troothId: row.trooth_id } : null;
  }

  /** bulk_operations/finish: download the result, map, send in parts, record Trooth's receipt. */
  async finishBulk(shop: string, bulkId: string, final: boolean): Promise<void> {
    const run = await this.d.store.runByBulkId(bulkId);
    if (!run || run.state !== "running" || run.shop !== shop) return;
    const ctx = await this.keyAndTrooth(shop);
    if (!ctx) {
      await this.failRun(shop, run.id, setStep(run.steps, "read", "failed", "This store is no longer connected to Trooth."), "This store is no longer connected to Trooth.");
      return;
    }
    let steps = run.steps;
    const gql = await this.d.gqlFor(shop);
    const st = await bulkStatus(gql, bulkId);
    if (!st || st.status !== "COMPLETED") {
      const msg = `Shopify stopped the product export (${(st?.errorCode ?? st?.status ?? "not found").toLowerCase()}). Press Sync now to try again.`;
      await this.failRun(shop, run.id, setStep(steps, "read", "failed", msg), msg);
      return;
    }
    const info = await shopInfo(gql);
    const totals: CatalogReceipt & { parts: number } = { signed: true, records: 0, offers: 0, skipped: 0, removed: 0, parts: 0 };
    let reason: string | undefined;
    const seen = new Set<string>();
    let products = 0;
    try {
      steps = setStep(steps, "read", "done", st.url ? "Shopify finished the export" : "Shopify found no active products");
      steps = setStep(steps, "prepare", "running", "Preparing products for Trooth");
      steps = setStep(steps, "send", "running", "Sending to Trooth");
      await this.d.store.updateRun(run.id, { steps });
      const send = async (batch: CatalogProduct[]) => {
        const doc = catalogDocument(shop, info, ctx.troothId, batch, this.now());
        const receipt = await this.d.trooth.postCatalog(ctx.troothId, doc, ctx.key);
        totals.parts++;
        totals.records += receipt.records;
        totals.offers += receipt.offers;
        totals.skipped += receipt.skipped;
        totals.removed += receipt.removed;
        if (!receipt.signed) {
          totals.signed = false;
          reason = receipt.reason;
        }
        await this.d.store.updateRun(run.id, { steps: (steps = setStep(steps, "send", "running", `${plural(totals.parts, "part", "parts")} sent`)) });
      };
      const envelope = new TextEncoder().encode(JSON.stringify(catalogDocument(shop, info, ctx.troothId, [], this.now()))).length;
      let batch: CatalogProduct[] = [];
      let size = envelope;
      const add = async (mapped: CatalogProduct) => {
        const n = new TextEncoder().encode(JSON.stringify(mapped)).length + 1;
        if (batch.length && size + n > CHUNK_MAX_BYTES) {
          await send(batch);
          batch = [];
          size = envelope;
        }
        batch.push(mapped);
        size += n;
      };
      const keep = async (mapped: CatalogProduct) => {
        seen.add(mapped.id);
        products++;
        await this.d.store.putProduct(shop, mapped.id, await productHash(mapped), JSON.stringify(mapped));
        await add(mapped);
      };
      if (st.url) {
        const fetchFile = this.d.fetchFile ?? ((i: string, init?: RequestInit) => fetch(i, init));
        const res = await withRetry(() => fetchFile(st.url!));
        if (!res.ok || !res.body) throw new ShopifyGraphqlError(`Shopify's export file answered ${res.status}.`, true);
        const result: BulkReadResult = { late: new Set(), bad: 0 };
        for await (const node of readBulkProducts(lines(res.body), result)) await keep(mapProduct(node, info.url));
        for (const gid of result.late) {
          const node = await productById(gql, gid);
          if (node && (node.status ?? "ACTIVE") === "ACTIVE") await keep(mapProduct(node, info.url));
        }
      }
      // Products Trooth had from an earlier sync that are no longer active are sent once as discontinued, then forgotten.
      for (const id of await this.d.store.productIds(shop)) {
        if (seen.has(id)) continue;
        const snap = await this.d.store.getProduct(shop, id);
        if (snap) await add(markDiscontinued(JSON.parse(snap.doc) as CatalogProduct));
        await this.d.store.deleteProduct(shop, id);
      }
      if (batch.length) await send(batch);
    } catch (e) {
      const retryable = e instanceof RetryExhausted || (e instanceof ShopifyGraphqlError && e.retryable) || (e instanceof TroothError && (e.status === 429 || e.status >= 500));
      if (retryable && !final) {
        await this.d.store.updateRun(run.id, { steps: setStep(steps, "send", "running", "Trooth or Shopify did not answer; trying again shortly") });
        throw e;
      }
      const msg = retryable
        ? "Trooth or Shopify did not answer after several tries. Press Sync now to try again."
        : e instanceof TroothError
          ? `Trooth did not accept the products: ${e.message}`
          : `The sync stopped: ${e instanceof Error ? e.message : String(e)}`;
      await this.failRun(shop, run.id, setStep(steps, steps.find((s) => s.key === "send")?.state === "running" ? "send" : "read", "failed", msg), msg);
      return;
    }
    steps = setStep(steps, "prepare", "done", `${plural(products, "product", "products")} prepared`);
    steps = setStep(steps, "send", "done", totals.parts ? `${plural(totals.parts, "part", "parts")} sent` : "Nothing to send");
    steps = setStep(
      steps,
      "receipt",
      "done",
      totals.signed ? `Trooth signed ${plural(totals.records, "product record", "product records")} and ${plural(totals.offers, "offer", "offers")}${totals.removed ? `; ${plural(totals.removed, "product", "products")} no longer on sale removed` : ""}${totals.skipped ? `; ${totals.skipped} skipped` : ""}` : `Trooth received the products and did not sign them: ${reason ?? "the company holds its own signing key"}`,
    );
    const at = this.now().toISOString();
    await this.d.store.updateRun(run.id, { state: "done", steps, products, records: totals.records, offers: totals.offers, skipped: totals.skipped, signed: totals.parts ? totals.signed : null, finished_at: at });
    await this.d.store.updateShop(shop, { last_sync_at: at, last_error: null });
    await this.d.store.logEvent(shop, "sync_done", `${products} products, ${totals.parts} parts`);
  }

  /** products/create and products/update: send the one product when what Trooth would receive changed. */
  async productChanged(shop: string, productGid: string): Promise<"sent" | "unchanged" | "removed" | "ignored"> {
    await this.reconcile(shop);
    const ctx = await this.keyAndTrooth(shop);
    if (!ctx) return "ignored";
    const gql = await this.d.gqlFor(shop);
    const node = await productById(gql, productGid);
    const id = legacyId(productGid);
    if (!node || (node.status ?? "ACTIVE") !== "ACTIVE") return (await this.productDeleted(shop, id)) === "sent" ? "removed" : "ignored";
    const info = await shopInfo(gql);
    const mapped = mapProduct(node, info.url);
    const hash = await productHash(mapped);
    const snap = await this.d.store.getProduct(shop, mapped.id);
    if (snap && snap.hash === hash) return "unchanged";
    await this.sendOne(shop, ctx, info, mapped);
    await this.d.store.putProduct(shop, mapped.id, hash, JSON.stringify(mapped));
    return "sent";
  }

  /** products/delete (and a product taken off sale): send it once as discontinued, then forget it. */
  async productDeleted(shop: string, productId: string): Promise<"sent" | "ignored"> {
    const ctx = await this.keyAndTrooth(shop);
    if (!ctx) return "ignored";
    const snap = await this.d.store.getProduct(shop, productId);
    if (!snap) return "ignored";
    const info = await shopInfo(await this.d.gqlFor(shop));
    await this.sendOne(shop, ctx, info, markDiscontinued(JSON.parse(snap.doc) as CatalogProduct));
    await this.d.store.deleteProduct(shop, productId);
    return "sent";
  }

  private async sendOne(shop: string, ctx: { key: ConnectorPrivateJwk; troothId: string }, info: ShopInfo, product: CatalogProduct): Promise<void> {
    for (const part of chunkProducts([product], 2048)) {
      await this.d.trooth.postCatalog(ctx.troothId, catalogDocument(shop, info, ctx.troothId, part, this.now()), ctx.key);
    }
    await this.d.store.updateShop(shop, { last_sync_at: this.now().toISOString() });
  }
}
