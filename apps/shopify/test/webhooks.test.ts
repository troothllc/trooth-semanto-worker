// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The webhook endpoint: HMAC before anything else (401 otherwise), the shop
// domain checked, each delivery handled once, the compliance topics answered
// 200 with nothing stored or queued for customer requests, and every other
// topic turned into the right queue job.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { FixtureD1 } from "./fixtures/d1";
import { AppStore } from "../app/lib/store.server";
import { handleWebhook, jobFor, COMPLIANCE_TOPICS } from "../app/lib/webhooks.server";
import type { SyncJob } from "../app/lib/env";

const SECRET = "fixture-client-secret";
const SHOP = "fixture-shop.myshopify.com";

function setup() {
  const d1 = new FixtureD1();
  const store = new AppStore(d1.asD1());
  const jobs: SyncJob[] = [];
  const deps = { secret: SECRET, store, enqueue: async (j: SyncJob) => void jobs.push(j) };
  return { store, jobs, deps };
}

function delivery(topic: string, payload: unknown, opts: { secret?: string; id?: string; shop?: string; hmac?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": opts.shop ?? SHOP,
    "x-shopify-webhook-id": opts.id ?? `wh_${Math.random().toString(36).slice(2)}`,
    "x-shopify-api-version": "2026-10",
  };
  if (opts.hmac !== null) headers["x-shopify-hmac-sha256"] = opts.hmac ?? createHmac("sha256", opts.secret ?? SECRET).update(body).digest("base64");
  return new Request("https://shopify.trooth.test/webhooks", { method: "POST", headers, body });
}

describe("webhook endpoint", () => {
  it("answers 401 to a missing or wrong HMAC, for every topic, the compliance topics included, and queues nothing", async () => {
    const { deps, jobs } = setup();
    for (const topic of [...COMPLIANCE_TOPICS, "app/uninstalled", "products/update"]) {
      expect((await handleWebhook(delivery(topic, { shop_domain: SHOP }, { hmac: null }), deps)).status).toBe(401);
      expect((await handleWebhook(delivery(topic, { shop_domain: SHOP }, { secret: "wrong" }), deps)).status).toBe(401);
    }
    expect(jobs).toEqual([]);
  });

  it("answers 200 to customers/data_request and customers/redact, storing no customer data and queuing nothing", async () => {
    const { deps, jobs, store } = setup();
    const customer = { id: 191167, email: "fixture-customer@example.com", phone: "555-625-1199" };
    const r1 = await handleWebhook(delivery("customers/data_request", { shop_id: 1, shop_domain: SHOP, orders_requested: [1], customer, data_request: { id: 9999 } }), deps);
    const r2 = await handleWebhook(delivery("customers/redact", { shop_id: 1, shop_domain: SHOP, customer, orders_to_redact: [1] }), deps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(jobs).toEqual([]);
    expect(await store.events(SHOP)).toEqual([]);
  });

  it("queues shop removal for app/uninstalled and shop/redact", async () => {
    const { deps, jobs } = setup();
    expect((await handleWebhook(delivery("app/uninstalled", { id: 1, domain: SHOP }), deps)).status).toBe(200);
    expect((await handleWebhook(delivery("shop/redact", { shop_id: 1, shop_domain: SHOP }), deps)).status).toBe(200);
    expect(jobs).toEqual([
      { kind: "remove_shop", shop: SHOP, reason: "uninstalled" },
      { kind: "remove_shop", shop: SHOP, reason: "shop_redact" },
    ]);
  });

  it("queues product and bulk jobs from their payloads", async () => {
    const { deps, jobs } = setup();
    await handleWebhook(delivery("products/update", { id: 1001, admin_graphql_api_id: "gid://shopify/Product/1001" }), deps);
    await handleWebhook(delivery("products/create", { id: 1002 }), deps);
    await handleWebhook(delivery("products/delete", { id: 1003 }), deps);
    await handleWebhook(delivery("bulk_operations/finish", { admin_graphql_api_id: "gid://shopify/BulkOperation/7", status: "completed" }), deps);
    expect(jobs).toEqual([
      { kind: "product_changed", shop: SHOP, product_gid: "gid://shopify/Product/1001" },
      { kind: "product_changed", shop: SHOP, product_gid: "gid://shopify/Product/1002" },
      { kind: "product_deleted", shop: SHOP, product_id: "1003" },
      { kind: "bulk_finished", shop: SHOP, bulk_operation_id: "gid://shopify/BulkOperation/7" },
    ]);
  });

  it("handles a delivery id once (Shopify may deliver twice)", async () => {
    const { deps, jobs } = setup();
    const a = await handleWebhook(delivery("products/delete", { id: 5 }, { id: "wh_same" }), deps);
    const b = await handleWebhook(delivery("products/delete", { id: 5 }, { id: "wh_same" }), deps);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(jobs).toHaveLength(1);
  });

  it("refuses a malformed shop domain, a body that is not JSON, a GET and an oversized body", async () => {
    const { deps } = setup();
    expect((await handleWebhook(delivery("products/update", { id: 1 }, { shop: "evil.example.com" }), deps)).status).toBe(400);
    const notJson = "not json";
    const req = new Request("https://shopify.trooth.test/webhooks", { method: "POST", headers: { "x-shopify-topic": "products/update", "x-shopify-shop-domain": SHOP, "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(notJson).digest("base64") }, body: notJson });
    expect((await handleWebhook(req, deps)).status).toBe(400);
    expect((await handleWebhook(new Request("https://shopify.trooth.test/webhooks"), deps)).status).toBe(405);
    const big = new Request("https://shopify.trooth.test/webhooks", { method: "POST", headers: { "content-length": String(2 * 1024 * 1024) }, body: "x" });
    expect((await handleWebhook(big, deps)).status).toBe(413);
  });

  it("ignores payloads it cannot use and topics it does not know, still answering 200", async () => {
    expect(jobFor("products/update", SHOP, { id: "not-a-number" })).toBeNull();
    expect(jobFor("bulk_operations/finish", SHOP, { admin_graphql_api_id: "gid://shopify/Product/1" })).toBeNull();
    expect(jobFor("orders/create", SHOP, {})).toBeNull();
    const { deps, jobs } = setup();
    expect((await handleWebhook(delivery("orders/create", {}), deps)).status).toBe(200);
    expect(jobs).toEqual([]);
  });
});
