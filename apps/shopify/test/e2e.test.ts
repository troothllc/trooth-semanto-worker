// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// End to end, the repository's style (vitest, no Cloudflare runtime, mocked
// neighbours): the Worker's fetch and queue handlers (app/worker.server.ts)
// with the real React Router loaders and actions, the real Shopify library
// doing token exchange with an App Bridge session token, sessions sealed in
// the fixture D1, the fixture Shopify (Admin GraphQL, bulk files, token
// exchange) and the fixture Trooth checking every signed request with the
// Worker's own verifier. One merchant's whole life with the app: install,
// welcome, connect, approve, first sync through a bulk operation and its
// webhook, a product update, settings, Disconnect, reconnect, uninstall and
// shop/redact, and the compliance webhooks.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { RequestType, setUpValidRequest } from "@shopify/shopify-api/test-helpers";
import { FixtureD1 } from "./fixtures/d1";
import { MockTrooth } from "./fixtures/mock-trooth";
import { MockShopify, fixtureProduct } from "./fixtures/mock-shopify";
import { SEAL_KEY } from "./fixtures/harness";
import { makeWorker, type QueueMessageLike } from "../app/worker.server";
import type { Env, SyncJob } from "../app/lib/env";
import { AppStore } from "../app/lib/store.server";
import * as home from "../app/routes/app._index";
import * as connect from "../app/routes/app.connect";
import * as sync from "../app/routes/app.sync";
import * as embed from "../app/routes/app.embed";
import * as settings from "../app/routes/app.settings";
import * as layout from "../app/routes/app";

const SHOP = "e2e-shop.myshopify.com";
const API_KEY = "e2e-client-id";
const SECRET = "e2e-client-secret";
const APP = "https://shopify.trooth.test";

const d1 = new FixtureD1();
const trooth = new MockTrooth(() => new Date());
const shopify = new MockShopify();
const sent: SyncJob[] = [];
const env: Env = {
  DB: d1.asD1(),
  SYNC_QUEUE: { send: async (job: SyncJob) => void sent.push(job), sendBatch: async () => undefined } as unknown as Queue<SyncJob>,
  SHOPIFY_API_KEY: API_KEY,
  SHOPIFY_API_SECRET: SECRET,
  SHOPIFY_APP_URL: APP,
  SHOPIFY_APP_HANDLE: "semanto-by-trooth",
  SCOPES: "read_products",
  TROOTH_API_BASE: trooth.base,
  TROOTH_DASHBOARD_URL: trooth.dashboard,
  APP_SEAL_KEY: SEAL_KEY,
};
const store = new AppStore(d1.asD1());
const ctx: Pick<ExecutionContext, "waitUntil"> = { waitUntil: () => undefined };

type RouteModule = { loader?: (a: never) => unknown; action?: (a: never) => unknown };
const ROUTES: Record<string, RouteModule[]> = { "/app": [layout, home], "/app/connect": [connect], "/app/sync": [sync], "/app/embed": [embed], "/app/settings": [layout, settings] };

/** A small stand-in for React Router's dispatch: the matched route modules' loader (GET) or action (POST), as data or a thrown Response. */
async function routeHandler(request: Request, context: { cloudflare: { env: Env; ctx: typeof ctx } }): Promise<Response> {
  const mods = ROUTES[new URL(request.url).pathname];
  if (!mods) return new Response("not found", { status: 404 });
  try {
    let last: unknown = null;
    if (request.method === "GET") for (const m of mods) last = m.loader ? await m.loader({ request: request.clone(), context, params: {} } as never) : last;
    else last = await mods.at(-1)!.action!({ request, context, params: {} } as never);
    return last instanceof Response ? last : Response.json(last);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

const worker = makeWorker(routeHandler);

async function embedded(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<Response> {
  const base = new Request(`${APP}${path}`, { method: init.method ?? "GET", ...(init.form ? { body: new URLSearchParams(init.form), headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });
  const req = init.method === "POST" || path !== "/app" ? await setUpValidRequest({ type: RequestType.Bearer, store: "e2e-shop", apiKey: API_KEY, apiSecretKey: SECRET }, base) : await setUpValidRequest({ type: RequestType.Admin, store: "e2e-shop", apiKey: API_KEY, apiSecretKey: SECRET }, base);
  return worker.fetch(req, env, ctx);
}

async function webhook(topic: string, payload: unknown, secret = SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request(`${APP}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-topic": topic, "x-shopify-shop-domain": SHOP, "x-shopify-webhook-id": `wh_${topic}_${Math.random()}`, "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64") },
      body,
    }),
    env,
    ctx,
  );
}

/** Run every queued job through the Worker's queue handler. */
async function drainQueue(): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  while (sent.length) {
    const job = sent.shift()!;
    const msg: QueueMessageLike = { body: job, attempts: 1, ack: () => void acked++, retry: () => void retried++ };
    await worker.queue({ messages: [msg] }, env);
  }
  return { acked, retried };
}

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = typeof input === "object" && "url" in input && !init ? input : null;
    const effectiveInit: RequestInit = req ? { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() } : (init ?? {});
    if (effectiveInit.headers instanceof Headers === false && effectiveInit.headers) effectiveInit.headers = new Headers(effectiveInit.headers as HeadersInit);
    const host = new URL(url).host;
    if (host.endsWith(".myshopify.com") || host === "storage.shopify.test") return shopify.fetch(url, effectiveInit);
    if (url.startsWith(trooth.base)) return trooth.fetch(url, effectiveInit);
    return new Response("unexpected host", { status: 599 });
  });
  shopify.setProducts(SHOP, [fixtureProduct(1), fixtureProduct(2, { variants: 2 })]);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("a merchant's whole life with the app", () => {
  it("install: the first embedded load exchanges the session token for an offline token, stores it sealed, and shows Welcome", async () => {
    const res = await embedded("/app");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: { step: string; connection: { state: string } } };
    expect(body.view.step).toBe("welcome");
    const row = await d1.prepare("SELECT sealed FROM shopify_sessions WHERE shop = ?").bind(SHOP).first<{ sealed: string }>();
    expect(row!.sealed).toMatch(/^v1\./);
    expect(row!.sealed).not.toContain("shpat_fixture");
    expect((await store.events(SHOP)).map((e) => e.action)).toContain("authorized");
  });

  it("Welcome, then Connect: a session is opened on Trooth and the screen gets the trooth.co approve address", async () => {
    expect((await embedded("/app", { method: "POST", form: { intent: "welcome" } })).status).toBe(200);
    const view = (await (await embedded("/app")).json()) as { view: { step: string } };
    expect(view.view.step).toBe("connect");
    const res = await embedded("/app/connect", { method: "POST", form: { intent: "start" } });
    const body = (await res.json()) as { approveUrl: string; connection: { state: string } };
    expect(res.status).toBe(200);
    expect(body.approveUrl.startsWith("https://trooth.co/dashboard/semanto/connect/")).toBe(true);
    expect(body.connection.state).toBe("pending");
  });

  it("the Connect screen's checks stay pending until the merchant approves, then the store is connected and the first sync starts", async () => {
    const pending = (await (await embedded("/app/connect")).json()) as { connection: { state: string } };
    expect(pending.connection.state).toBe("pending");
    trooth.approve(trooth.latestSession().id, "e2e-co");
    const done = (await (await embedded("/app/connect")).json()) as { connection: { state: string; troothId: string } };
    expect(done.connection).toMatchObject({ state: "connected", troothId: "e2e-co" });
    expect(shopify.metafields.get(SHOP)!.get("trooth.trooth_id")).toBe("e2e-co");
    const view = (await (await embedded("/app")).json()) as { view: { step: string; sync: { state: string } } };
    expect(view.view.step).toBe("embed");
    expect(view.view.sync.state).toBe("running");
  });

  it("the embed step records the state App Bridge reports", async () => {
    expect((await embedded("/app/embed", { method: "POST", form: { state: "bogus" } })).status).toBe(400);
    expect((await embedded("/app/embed", { method: "POST", form: { state: "active" } })).status).toBe(200);
    const view = (await (await embedded("/app")).json()) as { view: { step: string } };
    expect(view.view.step).toBe("sync");
  });

  it("bulk_operations/finish arrives as a webhook; the queue sends the catalog, signed, and the sync step shows each step done", async () => {
    const run = (await store.latestRun(SHOP))!;
    shopify.completeBulk(run.bulk_operation_id!);
    expect((await webhook("bulk_operations/finish", { admin_graphql_api_id: run.bulk_operation_id, status: "completed" })).status).toBe(200);
    const q = await drainQueue();
    expect(q).toEqual({ acked: 1, retried: 0 });
    expect(trooth.catalogs).toHaveLength(1);
    expect(trooth.catalogs[0]!.trooth_id).toBe("e2e-co");
    const s = (await (await embedded("/app/sync")).json()) as { sync: { state: string; run: { steps: { state: string }[] } } };
    expect(s.sync.state).toBe("done");
    expect(s.sync.run.steps.map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    const view = (await (await embedded("/app")).json()) as { view: { step: string; dashboardUrl: string } };
    expect(view.view.step).toBe("done");
    expect(view.view.dashboardUrl).toBe("https://trooth.co/dashboard/semanto");
  });

  it("a product update webhook sends that product; a wrong HMAC is refused with 401", async () => {
    const p = fixtureProduct(1);
    p.title = "Fixture Product 1, renamed";
    shopify.upsert(SHOP, p);
    expect((await webhook("products/update", { id: 1001, admin_graphql_api_id: "gid://shopify/Product/1001" }, "wrong-secret")).status).toBe(401);
    expect(sent).toHaveLength(0);
    expect((await webhook("products/update", { id: 1001, admin_graphql_api_id: "gid://shopify/Product/1001" })).status).toBe(200);
    await drainQueue();
    expect((trooth.catalogs.at(-1)!.doc.products as { name: string }[])[0]!.name).toBe("Fixture Product 1, renamed");
  });

  it("settings shows the connection, the last sync and recent activity; Sync now starts a new run", async () => {
    const res = await embedded("/app/settings");
    const body = (await res.json()) as { view: { connection: { state: string }; lastSyncAt: string | null }; events: { action: string }[] };
    expect(body.view.connection.state).toBe("connected");
    expect(body.view.lastSyncAt).not.toBeNull();
    expect(body.events.map((e) => e.action)).toContain("sync_done");
    const s = (await (await embedded("/app/sync", { method: "POST" })).json()) as { sync: { state: string } };
    expect(s.sync.state).toBe("running");
  });

  it("Disconnect needs the confirmation, then revokes the key at Trooth", async () => {
    const refused = (await (await embedded("/app/settings", { method: "POST", form: { intent: "disconnect" } })).json()) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect(trooth.activeKeysFor(SHOP)).toHaveLength(1);
    const ok = (await (await embedded("/app/settings", { method: "POST", form: { intent: "disconnect", confirm: "disconnect" } })).json()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect(shopify.metafields.get(SHOP)!.has("trooth.trooth_id")).toBe(false);
  });

  it("reconnect makes a new key; uninstall revokes it and deletes every row, sessions included", async () => {
    await embedded("/app/connect", { method: "POST", form: { intent: "start" } });
    trooth.approve(trooth.latestSession().id, "e2e-co");
    await embedded("/app/connect");
    expect(trooth.activeKeysFor(SHOP)).toHaveLength(1);
    expect((await webhook("app/uninstalled", { id: 1, domain: SHOP })).status).toBe(200);
    await drainQueue();
    expect(trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect(await store.rowCount(SHOP)).toBe(0);
  });

  it("compliance webhooks: customer requests answer 200 with nothing held; shop/redact 48 hours later answers 200 and nothing remains", async () => {
    expect((await webhook("customers/data_request", { shop_id: 1, shop_domain: SHOP, customer: { id: 1, email: "fixture@example.com" }, orders_requested: [], data_request: { id: 1 } })).status).toBe(200);
    expect((await webhook("customers/redact", { shop_id: 1, shop_domain: SHOP, customer: { id: 1, email: "fixture@example.com" }, orders_to_redact: [] })).status).toBe(200);
    expect((await webhook("shop/redact", { shop_id: 1, shop_domain: SHOP })).status).toBe(200);
    await drainQueue();
    expect(await store.rowCount(SHOP)).toBe(0);
    expect((await webhook("shop/redact", { shop_id: 1, shop_domain: SHOP }, "wrong")).status).toBe(401);
  });

  it("an app request without a session token gets only App Bridge's bounce page, never the shop's data", async () => {
    const res = await worker.fetch(new Request(`${APP}/app/connect`), env, ctx);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain("https://cdn.shopify.com/shopifycloud/app-bridge.js");
    expect(text).not.toContain("connection");
  });
});
