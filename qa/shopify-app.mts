// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Shopify app's own server code (apps/shopify/app/lib: ShopService,
// TroothClient, AppStore, the job runner) run against the live local Semanto
// Worker, with Shopify mocked (apps/shopify/test/fixtures/mock-shopify.ts) and
// the app's D1 on Node's SQLite (apps/shopify/test/fixtures/d1.ts, the app's
// migrations applied). The QA walk drives it through a small control server:
// Connect, the 2-second poll, the first sync, Disconnect, uninstall, and the
// app's clock for an abandoned install. Run: npx tsx qa/shopify-app.mts
//
//   POST /connect {shop}        ShopService.connect: key made, session opened
//   POST /poll {shop}           one poll, as the Connect screen does every 2 seconds
//   POST /view {shop}           the onboarding view (reconciles an expired pending connection)
//   POST /bulk {shop}           Shopify finishes the export; the app sends the catalog
//   POST /disconnect {shop}     Disconnect in Settings
//   POST /uninstall {shop}      the app/uninstalled webhook's work
//   POST /advance {ms}          move the app's clock
//   POST /state {shop}          the app's rows for the shop (no private key)

import http from "node:http";
import { readFileSync } from "node:fs";
import { FixtureD1 } from "../apps/shopify/test/fixtures/d1";
import { MockShopify } from "../apps/shopify/test/fixtures/mock-shopify";
import { AppStore } from "../apps/shopify/app/lib/store.server";
import { TroothClient } from "../apps/shopify/app/lib/trooth-client";
import { ShopService } from "../apps/shopify/app/lib/service.server";
import { gqlFromAdmin } from "../apps/shopify/app/lib/shopify-admin";
import { runJob } from "../apps/shopify/app/lib/jobs.server";
import type { Settings, SyncJob } from "../apps/shopify/app/lib/env";

const stack = JSON.parse(readFileSync(new URL("./.run/stack.json", import.meta.url), "utf8"));
const domain = stack.companies.acme.domain as string;
let offset = 0;
const now = () => new Date(Date.now() + offset);

class Shopify extends MockShopify {
  // The store's primary domain is the company's own, so product addresses are on the domain Semanto signs for.
  override graphql(shop: string, query: string, variables: Record<string, unknown> = {}): Response {
    if (/query\s+TroothShop\b/.test(query)) {
      this.operations.push({ shop, name: "TroothShop" });
      return Response.json({ data: { shop: { name: this.shopName(shop), currencyCode: "USD", myshopifyDomain: shop, primaryDomain: { url: `https://${domain}` } } } });
    }
    return super.graphql(shop, query, variables);
  }
}

const d1 = new FixtureD1();
const shopify = new Shopify();
const store = new AppStore(d1.asD1(), now);
const queue: { job: SyncJob; attempts: number }[] = [];
const settings: Settings = {
  apiKey: "qa-shopify-client-id",
  apiSecret: "qa-shopify-client-secret",
  appUrl: "https://shopify-app.qa.invalid",
  appHandle: "semanto-by-trooth",
  scopes: ["read_products"],
  troothApiBase: stack.api,
  dashboardUrl: `${stack.dashboard}/dashboard/semanto`,
  sealKey: Buffer.from("qa-seal-key-32-bytes-long-here!!").toString("base64"),
};
const client = new TroothClient(settings.troothApiBase, settings.dashboardUrl, (i, init) => fetch(i, init), {}, now);
const service = new ShopService({
  store,
  settings,
  trooth: client,
  enqueue: async (job) => void queue.push({ job, attempts: 1 }),
  gqlFor: async (shop) => gqlFromAdmin({ graphql: async (q, o) => shopify.graphql(shop, q, o?.variables) }, {}),
  fetchFile: (i, init) => shopify.fetch(i, init),
  now,
});
const products = (shop: string) => [
  { id: "gid://shopify/Product/1001", legacyResourceId: 1001, title: "Classic Kettle", handle: "kettle", status: "ACTIVE", onlineStoreUrl: `https://${domain}/products/kettle`, description: "A 1.7 litre kettle.", variants: [{ id: "gid://shopify/ProductVariant/2001", legacyResourceId: 2001, title: "Default", sku: "KET-001", barcode: "00012345678905", price: "49.00", availableForSale: true, selectedOptions: [] }] },
  { id: "gid://shopify/Product/1002", legacyResourceId: 1002, title: "Stone Teapot", handle: "teapot", status: "ACTIVE", onlineStoreUrl: `https://${domain}/products/teapot`, description: "A stoneware teapot.", variants: [{ id: "gid://shopify/ProductVariant/2002", legacyResourceId: 2002, title: "Default", sku: "TEA-002", barcode: null, price: "35.00", availableForSale: true, selectedOptions: [] }] },
].map((p) => ({ ...p, updatedAt: new Date().toISOString() }));

async function drain(): Promise<string[]> {
  const errors: string[] = [];
  while (queue.length) {
    const item = queue.shift()!;
    try {
      await runJob(item.job, service, item.attempts);
    } catch (e) {
      errors.push(String(e));
    }
  }
  return errors;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const shop = body.shop as string;
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/connect") { shopify.setProducts(shop, products(shop) as never); return send(200, await service.connect(shop)); }
      if (url.pathname === "/poll") { const c = await service.poll(shop); return send(200, { connection: c, errors: await drain() }); }
      if (url.pathname === "/view") return send(200, await service.view(shop));
      if (url.pathname === "/bulk") {
        const op = [...shopify.bulkOps.values()].reverse().find((o) => o.shop === shop);
        if (!op) return send(409, { error: "no bulk operation for this shop" });
        shopify.completeBulk(op.id);
        await service.finishBulk(shop, op.id, true);
        const errors = await drain();
        return send(200, { sync: await service.syncView(shop), errors });
      }
      if (url.pathname === "/disconnect") return send(200, { outcome: await service.disconnect(shop) });
      if (url.pathname === "/uninstall") { await service.removeShop(shop, "uninstalled", true); return send(200, { gone: !(await store.getShop(shop)) }); }
      if (url.pathname === "/advance") { offset += Number(body.ms || 0); return send(200, { now: now().toISOString() }); }
      if (url.pathname === "/state") {
        const row = await store.getShop(shop);
        const events = row ? await store.events(shop, 20) : [];
        const safe = row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, /key|token|seal/i.test(k) ? (v ? "[held]" : null) : v])) : null;
        return send(200, { row: safe, events });
      }
      return send(404, { error: "no such control" });
    } catch (e) {
      return send(500, { error: String((e as Error)?.stack ?? e).slice(0, 1500) });
    }
  });
});
server.listen(Number(process.env.QA_SHOPIFY_PORT || 47105), "127.0.0.1", () => console.log("qa shopify app control ready"));
