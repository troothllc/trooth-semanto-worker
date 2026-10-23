// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's work for a shop, against the fixture Trooth (which checks every
// signed request with the Worker's own verifier) and the fixture Shopify:
// connecting, every way an install can be abandoned (no orphaned key, no half
// state), the first sync through a bulk operation, Sync now, incremental
// product updates and deletes, retries, Disconnect, uninstall and shop/redact.

import { describe, expect, it } from "vitest";
import { harness, connected, SHOP, TROOTH_ID } from "./fixtures/harness";
import { fixtureProduct } from "./fixtures/mock-shopify";

const MIN = 60 * 1000;

describe("connect to Trooth", () => {
  it("starts a session with the shop's public key only and stores the private key sealed", async () => {
    const h = harness();
    const r = await h.service.connect(SHOP);
    const s = h.trooth.latestSession();
    expect(r.approveUrl).toBe(`https://trooth.co/dashboard/semanto/connect/${s.id}`);
    expect(s.shop).toBe(SHOP);
    expect("d" in s.public_jwk).toBe(false);
    const row = (await h.store.getShop(SHOP))!;
    expect(row.conn_state).toBe("pending");
    expect(row.kid).toBe(s.public_jwk.kid);
    expect(row.private_jwk_sealed).toMatch(/^v1\./);
    expect(row.private_jwk_sealed).not.toContain('"d"');
    expect(row.poll_token_sealed).not.toContain(s.poll_token);
  });

  it("pressing Connect again while pending reuses the same session and key", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    const kid = (await h.store.getShop(SHOP))!.kid;
    await h.service.connect(SHOP);
    expect(h.trooth.sessions.size).toBe(1);
    expect((await h.store.getShop(SHOP))!.kid).toBe(kid);
  });

  it("stays pending until approved, then connects, writes the embed values and starts the first sync", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await h.service.connect(SHOP);
    expect((await h.service.poll(SHOP)).state).toBe("pending");
    h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
    const c = await h.service.poll(SHOP);
    expect(c).toMatchObject({ state: "connected", troothId: TROOTH_ID });
    expect(h.shopify.metafields.get(SHOP)).toEqual(new Map([["trooth.trooth_id", TROOTH_ID], ["trooth.api_base", h.trooth.base]]));
    const row = (await h.store.getShop(SHOP))!;
    expect(row.poll_token_sealed).toBeNull();
    expect(row.session_id).toBeNull();
    const run = await h.store.latestRun(SHOP);
    expect(run).toMatchObject({ kind: "first", state: "running" });
    expect(run!.bulk_operation_id).toMatch(/^gid:\/\/shopify\/BulkOperation\//);
  });

  it("a start that Trooth refuses stores no key at all", async () => {
    const h = harness();
    h.trooth.fetch = async () => new Response(JSON.stringify({ code: "rate_limited", detail: "Too many requests." }), { status: 429 });
    await expect(h.service.connect(SHOP)).rejects.toThrow("Too many requests.");
    const row = (await h.store.getShop(SHOP))!;
    expect(row.conn_state).toBe("none");
    expect(row.private_jwk_sealed).toBeNull();
    expect(row.kid).toBeNull();
  });

  it("refuses an approve address outside trooth.co", async () => {
    const h = harness();
    const real = h.trooth.fetch.bind(h.trooth);
    h.trooth.fetch = async (i, init) => {
      const res = await real(i, init);
      const j = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...j, approve_url: "https://evil.example/approve" }, { status: res.status });
    };
    await expect(h.service.connect(SHOP)).rejects.toThrow("outside trooth.co");
    expect((await h.store.getShop(SHOP))!.private_jwk_sealed).toBeNull();
  });
});

describe("abandoned installs leave nothing behind", () => {
  it("merchant closes the window: the session expires and the next poll removes the pending key", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.advance(15 * MIN);
    const c = await h.service.poll(SHOP);
    expect(c).toEqual({ state: "none", reason: "expired" });
    const row = (await h.store.getShop(SHOP))!;
    expect([row.conn_state, row.kid, row.private_jwk_sealed, row.session_id, row.poll_token_sealed]).toEqual(["none", null, null, null, null]);
    expect(h.trooth.keys.size).toBe(0);
  });

  it("merchant never comes back to the Connect screen: the next time anything reads the shop the expired session is settled", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.advance(20 * MIN);
    const view = await h.service.view(SHOP);
    expect(view.connection.state).toBe("none");
    expect((await h.store.getShop(SHOP))!.private_jwk_sealed).toBeNull();
  });

  it("merchant approves after closing the app: the approval is kept the next time the app opens, not orphaned", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
    h.advance(20 * MIN);
    const view = await h.service.view(SHOP);
    expect(view.connection).toMatchObject({ state: "connected", troothId: TROOTH_ID });
    expect(h.trooth.activeKeysFor(SHOP)).toHaveLength(1);
  });

  it("Trooth cannot be reached when an expired session is settled: the key is removed anyway", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.advance(20 * MIN);
    h.trooth.fetch = async () => {
      throw new TypeError("network down");
    };
    await h.service.view(SHOP);
    expect((await h.store.getShop(SHOP))!.private_jwk_sealed).toBeNull();
    expect((await h.store.events(SHOP)).map((e) => e.action)).toContain("connect_abandoned");
  });

  it("merchant declines on trooth.co: the key is removed and the screen says declined", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.trooth.deny(h.trooth.latestSession().id);
    expect(await h.service.poll(SHOP)).toEqual({ state: "none", reason: "denied" });
    expect((await h.store.getShop(SHOP))!.private_jwk_sealed).toBeNull();
    expect((await h.service.view(SHOP)).connection).toEqual({ state: "none", reason: "denied" });
  });

  it("merchant uninstalls while the request is pending: the never-registered key is revoked (Trooth answers not registered) and every row is deleted", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    await h.service.removeShop(SHOP, "uninstalled", false);
    expect(h.trooth.revocations).toEqual([{ kid: expect.any(String), reason: "uninstalled", registered: false }]);
    expect(await h.store.rowCount(SHOP)).toBe(0);
  });

  it("merchant uninstalls after approving but before the app saw it: the registered key is revoked", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
    await h.service.removeShop(SHOP, "uninstalled", false);
    expect(h.trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect(h.trooth.revocations[0]).toMatchObject({ registered: true, reason: "uninstalled" });
    expect(await h.store.rowCount(SHOP)).toBe(0);
  });

  it("an approval that races the session's end is not orphaned: the key is revoked at Trooth when the app discards it", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    const s = h.trooth.latestSession();
    h.trooth.approve(s.id, TROOTH_ID);
    // The session is gone from Trooth's side by the time the app checks (the Worker answers 401), so the app reads it as expired.
    s.poll_token = "rotated";
    expect((await h.service.poll(SHOP)).state).toBe("none");
    expect(h.trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect((await h.store.getShop(SHOP))!.private_jwk_sealed).toBeNull();
  });

  it("a 429 from Trooth's shared connect rate limit keeps the Connect screen waiting instead of failing", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    const real = h.trooth.fetch.bind(h.trooth);
    h.trooth.fetch = async (i, init) => (new URL(i).pathname.startsWith("/public/semanto/connect/sessions/") ? new Response(JSON.stringify({ code: "rate_limited", detail: "Slow down." }), { status: 429, headers: { "retry-after": "6" } }) : real(i, init));
    expect((await h.service.poll(SHOP)).state).toBe("pending");
    h.trooth.fetch = real;
    h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
    expect((await h.service.poll(SHOP)).state).toBe("connected");
  });

  it("Trooth trusts only the shop's own key: a key approved for another kid is refused, not used", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    const s = h.trooth.latestSession();
    s.state = "approved";
    s.trooth_id = TROOTH_ID;
    s.public_jwk = { ...s.public_jwk, kid: "someone-elses-kid" };
    await h.service.poll(SHOP);
    const row = (await h.store.getShop(SHOP))!;
    expect(row.conn_state).toBe("none");
    expect(row.private_jwk_sealed).toBeNull();
    expect(row.last_error).toContain("different key");
  });
});

describe("first sync and Sync now", () => {
  it("runs the bulk operation, sends signed parts the Worker's checker accepts, and records Trooth's receipt per step", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1), fixtureProduct(2, { variants: 3 }), fixtureProduct(3, { status: "DRAFT" })]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    expect(run.steps.map((s) => [s.key, s.state])).toEqual([
      ["read", "running"],
      ["prepare", "waiting"],
      ["send", "waiting"],
      ["receipt", "waiting"],
    ]);
    h.shopify.completeBulk(run.bulk_operation_id!);
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    const done = (await h.store.getRun(run.id))!;
    expect(done.state).toBe("done");
    expect(done.steps.every((s) => s.state === "done")).toBe(true);
    expect(done.products).toBe(2);
    expect(done.records).toBe(4);
    expect(done.signed).toBe(true);
    expect(h.trooth.catalogs).toHaveLength(1);
    expect(h.trooth.catalogs[0]!.doc).toMatchObject({ source: "shopify", trooth_id: TROOTH_ID, currency: "USD", shop: SHOP });
    expect((await h.store.getShop(SHOP))!.last_sync_at).not.toBeNull();
    expect(await h.store.productIds(SHOP)).toEqual(["1001", "1002"]);
  });

  it("reads progress only when asked, and a bulk operation Shopify stops ends the run with a plain message", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.bulkOps.get(run.bulk_operation_id!)!.objectCount = 12;
    const v = await h.service.refreshProgress(SHOP);
    expect(v.state === "running" && v.run.steps[0]!.detail).toBe("12 items read so far");
    h.shopify.failBulk(run.bulk_operation_id!);
    const f = await h.service.refreshProgress(SHOP);
    expect(f.state).toBe("failed");
    expect(f.state === "failed" && f.run.error).toContain("Press Sync now");
  });

  it("a store with no active products finishes with nothing to send", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, []);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    const done = (await h.store.getRun(run.id))!;
    expect(done.state).toBe("done");
    expect(done.steps.find((s) => s.key === "read")!.detail).toBe("Shopify found no active products");
    expect(done.steps.find((s) => s.key === "send")!.detail).toBe("Nothing to send");
    expect(h.trooth.catalogs).toHaveLength(0);
  });

  it("variants written after a later product are read one by one, so no variant is lost", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1, { variants: 3 }), fixtureProduct(2)]);
    h.shopify.shuffleJsonl = true;
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    const sent = h.trooth.catalogs.flatMap((c) => c.doc.products as { id: string; variants: unknown[] }[]);
    const p1 = sent.filter((p) => p.id === "1001");
    expect(p1.at(-1)!.variants).toHaveLength(3);
  });

  it("Sync now while a sync runs answers the running one; another app's export in progress is a plain message", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const first = (await h.store.latestRun(SHOP))!;
    expect((await h.service.startSync(SHOP, "manual")).id).toBe(first.id);
    h.shopify.completeBulk(first.bulk_operation_id!);
    await h.service.finishBulk(SHOP, first.bulk_operation_id!, false);
    h.shopify.bulkBusy = true;
    const busy = await h.service.startSync(SHOP, "manual");
    expect(busy.state).toBe("failed");
    expect(busy.error).toContain("already exporting products");
  });

  it("Sync now sends products that left the store once as discontinued and forgets them", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1), fixtureProduct(2)]);
    await connected(h);
    const first = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(first.bulk_operation_id!);
    await h.service.finishBulk(SHOP, first.bulk_operation_id!, false);
    h.shopify.remove(SHOP, "gid://shopify/Product/1002");
    const second = await h.service.startSync(SHOP, "manual");
    h.shopify.completeBulk(second.bulk_operation_id!);
    await h.service.finishBulk(SHOP, second.bulk_operation_id!, false);
    const last = h.trooth.catalogs.at(-1)!.doc.products as { id: string; stock_status: string }[];
    expect(last.map((p) => [p.id, p.stock_status])).toEqual([
      ["1001", "instock"],
      ["1002", "discontinued"],
    ]);
    expect(await h.store.productIds(SHOP)).toEqual(["1001"]);
  });

  it("Sync before connecting is refused in plain words", async () => {
    const h = harness();
    await h.store.ensureShop(SHOP);
    await expect(h.service.startSync(SHOP, "manual")).rejects.toThrow("Connect this store to Trooth before syncing.");
  });

  it("retries 429 and 5xx from Trooth with a fresh signature each time, then succeeds", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    h.trooth.failNext = { count: 2, status: 503 };
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    expect((await h.store.getRun(run.id))!.state).toBe("done");
    expect(h.trooth.calls.filter((c) => c.path.endsWith("/commerce/catalog")).map((c) => c.status)).toEqual([503, 503, 202]);
  });

  it("when Trooth stays down, the queue retries the job; on the last attempt the run fails with a plain message", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    h.trooth.failNext = { count: 1000, status: 503 };
    h.queue.push({ job: { kind: "bulk_finished", shop: SHOP, bulk_operation_id: run.bulk_operation_id! }, attempts: 1 });
    const errors = await h.drain();
    expect(errors).toHaveLength(3);
    const failed = (await h.store.getRun(run.id))!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("did not answer after several tries");
  });

  it("a company that holds its own signing key: Trooth receives the products and the receipt says they were not signed", async () => {
    const h = harness();
    h.trooth.signs = false;
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    const done = (await h.store.getRun(run.id))!;
    expect(done.signed).toBe(false);
    expect(done.steps.find((s) => s.key === "receipt")!.detail).toContain("did not sign them");
  });

  it("Shopify throttling is retried", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    h.shopify.throttleNext = 2;
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    expect((await h.store.getRun(run.id))!.state).toBe("done");
  });
});

describe("incremental updates from product webhooks", () => {
  async function synced() {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    const run = (await h.store.latestRun(SHOP))!;
    h.shopify.completeBulk(run.bulk_operation_id!);
    await h.service.finishBulk(SHOP, run.bulk_operation_id!, false);
    return h;
  }

  it("a changed product is sent alone; an update that changes nothing Trooth reads sends nothing", async () => {
    const h = await synced();
    const before = h.trooth.catalogs.length;
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1001")).toBe("unchanged");
    const p = fixtureProduct(1);
    p.variants[0]!.price = "15.00";
    h.shopify.upsert(SHOP, p);
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1001")).toBe("sent");
    expect(h.trooth.catalogs.length).toBe(before + 1);
    expect((h.trooth.catalogs.at(-1)!.doc.products as { price: string }[])[0]!.price).toBe("15.00");
  });

  it("a new product is sent; a product set to draft is sent once as discontinued; a deleted product likewise", async () => {
    const h = await synced();
    h.shopify.upsert(SHOP, fixtureProduct(9));
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1009")).toBe("sent");
    h.shopify.upsert(SHOP, fixtureProduct(9, { status: "DRAFT" }));
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1009")).toBe("removed");
    expect((h.trooth.catalogs.at(-1)!.doc.products as { stock_status: string }[])[0]!.stock_status).toBe("discontinued");
    h.shopify.remove(SHOP, "gid://shopify/Product/1001");
    expect(await h.service.productDeleted(SHOP, "1001")).toBe("sent");
    expect(await h.service.productDeleted(SHOP, "1001")).toBe("ignored");
    expect(await h.store.productIds(SHOP)).toEqual([]);
  });

  it("product webhooks for a store that is not connected do nothing", async () => {
    const h = harness();
    await h.store.ensureShop(SHOP);
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1001")).toBe("ignored");
    expect(await h.service.productDeleted(SHOP, "1001")).toBe("ignored");
    expect(h.trooth.catalogs).toHaveLength(0);
  });
});

describe("Disconnect, uninstall and shop/redact", () => {
  it("revocation outcomes are told apart: never registered is recorded as nothing to revoke, a refusal is an error the settings page shows", async () => {
    const h = harness();
    await h.service.connect(SHOP);
    h.trooth.deny(h.trooth.latestSession().id);
    await h.service.poll(SHOP);
    expect((await h.store.events(SHOP)).map((e) => e.action)).toContain("key_not_registered");
    expect((await h.service.view(SHOP)).revokeError).toBeNull();

    await connected(h);
    const kid = (await h.store.getShop(SHOP))!.kid!;
    h.trooth.keys.get(kid)!.source = "cloudflare-worker";
    await expect(h.service.disconnect(SHOP)).rejects.toThrow("Trooth refused to revoke");
    const view = await h.service.view(SHOP);
    expect(view.connection.state).toBe("connected");
    expect(view.revokeError).toContain("answer 403");
    expect((await h.store.events(SHOP))[0]!.action).toBe("revoke_refused");
  });

  it("shop/redact revokes with reason shop_redact; Disconnect with reason disconnected", async () => {
    const h = harness();
    await connected(h);
    await h.service.removeShop(SHOP, "shop_redact", false);
    expect(h.trooth.revocations.at(-1)).toMatchObject({ reason: "shop_redact", registered: true });
  });

  it("a refusal on uninstall is logged as an error and the shop's rows are still deleted", async () => {
    const h = harness();
    await connected(h);
    h.trooth.keys.get((await h.store.getShop(SHOP))!.kid!)!.source = "cloudflare-worker";
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void logged.push(m);
    try {
      await h.service.removeShop(SHOP, "uninstalled", false);
    } finally {
      console.error = orig;
    }
    expect(logged.some((l) => l.includes('"event":"revoke_refused"') && l.includes('"status":403'))).toBe(true);
    expect(await h.store.rowCount(SHOP)).toBe(0);
  });

  it("Disconnect revokes the key at Trooth, clears the embed values and keeps the app installed", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    await h.service.disconnect(SHOP);
    expect(h.trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect(h.trooth.revocations.at(-1)).toMatchObject({ reason: "disconnected", registered: true });
    expect(h.shopify.metafields.get(SHOP)!.size).toBe(0);
    const row = (await h.store.getShop(SHOP))!;
    expect([row.conn_state, row.trooth_id, row.private_jwk_sealed]).toEqual(["none", null, null]);
    // A revoked key can no longer send.
    expect(await h.service.productChanged(SHOP, "gid://shopify/Product/1001")).toBe("ignored");
  });

  it("uninstall revokes and deletes every row; a second delivery and shop/redact 48 hours later are harmless", async () => {
    const h = harness();
    h.shopify.setProducts(SHOP, [fixtureProduct(1)]);
    await connected(h);
    await h.service.removeShop(SHOP, "uninstalled", false);
    expect(h.trooth.activeKeysFor(SHOP)).toHaveLength(0);
    expect(await h.store.rowCount(SHOP)).toBe(0);
    await h.service.removeShop(SHOP, "uninstalled", false);
    await h.service.removeShop(SHOP, "shop_redact", false);
    expect(await h.store.rowCount(SHOP)).toBe(0);
  });

  it("when Trooth cannot be reached on uninstall, the queue retries, and the last attempt still deletes the rows", async () => {
    const h = harness();
    await connected(h);
    h.trooth.failNext = { count: 1000, status: 503 };
    h.queue.push({ job: { kind: "remove_shop", shop: SHOP, reason: "uninstalled" }, attempts: 1 });
    const errors = await h.drain();
    expect(errors).toHaveLength(3);
    expect(await h.store.rowCount(SHOP)).toBe(0);
  });
});
