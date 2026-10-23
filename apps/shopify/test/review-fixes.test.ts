// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Regression tests for the backend review of 23 October 2026
// (trooth-semanto-worker/docs/program/reports/review-backend.md), the Shopify
// app's findings: each test names its finding and fails on the code before the
// fix. Fixture D1, fixture Trooth and fixture Shopify only.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { harness, connected, SHOP, TROOTH_ID } from "./fixtures/harness";
import { fixtureProduct } from "./fixtures/mock-shopify";
import { FixtureD1 } from "./fixtures/d1";
import { AppStore } from "../app/lib/store.server";
import { handleWebhook } from "../app/lib/webhooks.server";
import type { SyncJob } from "../app/lib/env";

const SECRET = "fixture-client-secret";

function delivery(topic: string, id: string) {
  const body = JSON.stringify({ shop_domain: SHOP });
  return new Request("https://shopify.trooth.test/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-topic": topic, "x-shopify-shop-domain": SHOP, "x-shopify-webhook-id": id, "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(body).digest("base64") },
    body,
  });
}

describe("review findings, Shopify app", () => {
  it("S1: an uninstall whose job could not be queued answers 503 and is handled when Shopify delivers it again", async () => {
    const store = new AppStore(new FixtureD1().asD1());
    const jobs: SyncJob[] = [];
    let down = true;
    const deps = { secret: SECRET, store, enqueue: async (j: SyncJob) => { if (down) throw new Error("queue unavailable"); jobs.push(j); } };
    expect((await handleWebhook(delivery("app/uninstalled", "wh_uninstall_1"), deps)).status).toBe(503);
    down = false;
    const again = await handleWebhook(delivery("app/uninstalled", "wh_uninstall_1"), deps);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("OK");
    expect(jobs).toEqual([{ kind: "remove_shop", shop: SHOP, reason: "uninstalled" }]);
  });

  it("S2: two deliveries of the same webhook at the same moment queue its work once", async () => {
    const store = new AppStore(new FixtureD1().asD1());
    const jobs: SyncJob[] = [];
    const deps = { secret: SECRET, store, enqueue: async (j: SyncJob) => void jobs.push(j) };
    const [a, b] = await Promise.all([handleWebhook(delivery("shop/redact", "wh_redact_1"), deps), handleWebhook(delivery("shop/redact", "wh_redact_1"), deps)]);
    expect([await a.text(), await b.text()].sort()).toEqual(["Already handled.", "OK"]);
    expect(jobs).toHaveLength(1);
    expect([await store.claimWebhook("wh_x", SHOP, "t"), await store.claimWebhook("wh_x", SHOP, "t")]).toEqual([true, false]);
  });

  it("S3: two Connect presses at the same moment hand back one approval address, the one the store keeps", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.connect(SHOP), h.service.connect(SHOP)]);
    const row = (await h.store.getShop(SHOP))!;
    expect(a.approveUrl).toBe(b.approveUrl);
    expect(row.approve_url).toBe(a.approveUrl);
    // Approving the address both screens show connects the store.
    const sessionId = a.approveUrl.split("/").pop()!;
    h.trooth.approve(sessionId, TROOTH_ID);
    expect((await h.service.poll(SHOP)).state).toBe("connected");
  });

  it("S4: two checks that both see the approval connect once and start one first sync", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await h.service.markWelcomeDone(SHOP);
    await h.service.connect(SHOP);
    h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
    const [a, b] = await Promise.all([h.service.poll(SHOP), h.service.poll(SHOP)]);
    expect([a.state, b.state]).toEqual(["connected", "connected"]);
    expect((await h.store.events(SHOP, 50)).filter((e) => e.action === "connected")).toHaveLength(1);
    expect(h.d1.db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE shop = ?").get(SHOP)).toEqual({ n: 1 });
    expect((await h.store.latestRun(SHOP))!.state).toBe("running");
  });

  it("S5: two presses of Sync now at the same moment answer one running sync", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    await h.drain();
    const [a, b] = await Promise.all([h.service.startSync(SHOP, "manual"), h.service.startSync(SHOP, "manual")]);
    expect(a.id).toBe(b.id);
    expect(h.d1.db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE shop = ? AND state = 'running'").get(SHOP)).toEqual({ n: 1 });
  });

  it("S6: the activity list keeps the newest 200 events per shop", async () => {
    const h = harness();
    for (let i = 0; i < 205; i++) await h.store.logEvent(SHOP, "sync_started", `run ${i}`);
    expect(h.d1.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE shop = ?").get(SHOP)).toEqual({ n: 200 });
    expect((await h.store.events(SHOP, 1))[0]!.detail).toBe("run 204");
  });

  it("S7: Disconnect says what happened at Trooth", async () => {
    const h = harness();
    await connected(h);
    expect(await h.service.disconnect(SHOP)).toBe("revoked");
    expect(await h.service.disconnect(SHOP)).toBe("nothing");
  });

  it("migration 0002 adds one index and its down file removes it, so 0002 applies again", () => {
    const d1 = new FixtureD1();
    const has = () => (d1.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'sync_runs_one_running'").get() as { n: number }).n;
    expect(has()).toBe(1);
    d1.db.exec(readFileSync(new URL("../migrations-down/0002_review_fixes.down.sql", import.meta.url), "utf8"));
    expect(has()).toBe(0);
    d1.db.exec(readFileSync(new URL("../migrations/0002_review_fixes.sql", import.meta.url), "utf8"));
    expect(has()).toBe(1);
  });
});
