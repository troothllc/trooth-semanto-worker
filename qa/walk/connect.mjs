// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: the connect approve page for the Shopify flow, driven by the Shopify
// app's own server code (qa/shopify-app.mts) against the live Worker: Connect
// in the app, the approve page in the dashboard, Approve (double clicked),
// Return to Shopify, the app finishing on its poll and sending its first
// catalog; Deny; and the abandoned installs (the request expired, the window
// closed, the app uninstalled before approval), each leaving no key behind.

import { spawn } from "node:child_process";
import { load, shoot, see, d1, BASE } from "./lib.mjs";
import { posts } from "./delivery.mjs";

const APP = "http://127.0.0.1:47105";
const app = (path, body = {}) => fetch(APP + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

export async function startShopifyApp(w) {
  // tsx run in this process's node (no npx shell in between), so killing the child ends the app.
  const root = new URL("../..", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--import", "tsx", "qa/shopify-app.mts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => child.kill());
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60 && !/control ready/.test(out); i++) await new Promise((r) => setTimeout(r, 500));
  if (!/control ready/.test(out)) w.note(`the Shopify app did not start: ${out.slice(-600)}`);
  return child;
}

const keysFor = (troothId, shop) => d1("SELECT kid, source, revoked_at FROM semanto_connector_keys WHERE trooth_id = ? AND source = ?", troothId, `shopify:${shop}`);

export async function connectShopify(w, ctx) {
  const child = await startShopifyApp(w);
  try {
    const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));

    // The happy path: Connect in the app, Approve in the dashboard, Return to Shopify.
    w.step("connect-request");
    const shop = "qa-kettles.myshopify.com";
    const c = await app("/connect", { shop });
    if (!c.approveUrl?.startsWith(`${BASE}/dashboard/semanto/connect/`)) w.note(`the approve address is ${c.approveUrl}`);
    await page.goto(c.approveUrl);
    await page.waitForSelector("main h1");
    await see(w, page, "Shopify wants to send your catalog to Trooth");
    await see(w, page, shop);
    await see(w, page, "Store key");
    await shoot(w, page, "connect-pending", { keys: true });
    w.step("connect-approve");
    await page.getByRole("button", { name: "Approve" }).dblclick();
    await see(w, page, /Approved\. Shopify for .* is connected to/);
    await page.waitForTimeout(500);
    const approves = posts(w, /\/connect\/[^/]+\/approve$/).length;
    if (approves !== 1) w.note(`a double click on Approve sent ${approves} approvals`);
    const ret = page.getByRole("link", { name: "Return to Shopify" });
    const href = await ret.getAttribute("href");
    if (href !== `https://${shop}/admin/apps/semanto-by-trooth`) w.note(`Return to Shopify links to ${href}`);
    await shoot(w, page, "connect-approved", { keys: true });
    // Return to Shopify is a link out: the browser is sent to the store's admin (answered here, not fetched from Shopify).
    await page.route(`https://${shop}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Shopify admin (QA stand-in)</title><h1>Shopify admin</h1>" }));
    await ret.click();
    await page.waitForURL(`https://${shop}/admin/apps/semanto-by-trooth`, { timeout: 10_000 }).catch(() => w.note("Return to Shopify did not open the store's admin"));
    await page.unroute(`https://${shop}/**`);
    // The app's next poll sees the approval, finishes and starts its first sync; Shopify finishes the export; the catalog is signed and sent.
    w.step("connect-app-finishes");
    const polled = await app("/poll", { shop });
    if (polled.connection?.state !== "connected") w.note(`the app's poll after approval answered ${JSON.stringify(polled.connection)}`);
    const sync = await app("/bulk", { shop });
    if (sync.sync?.state !== "done") w.note(`the first sync did not finish: ${JSON.stringify({ steps: sync.sync?.run?.steps, error: sync.sync?.run?.error ?? sync.sync?.error, errors: sync.errors }).slice(0, 1200)}`);
    const offers = await d1("SELECT sku FROM semanto_offers WHERE trooth_id = ?", ctx.troothId);
    if (!offers.some((o) => o.sku === "TEA-002")) w.note("the app's catalog did not reach the Worker (no TEA-002 offer)");
    const k = await keysFor(ctx.troothId, shop);
    if (k.length !== 1 || k[0].revoked_at) w.note(`the store's connector key: ${JSON.stringify(k)}`);
    ctx.shopifyShop = shop;
    // The same link again: already approved.
    await page.goto(c.approveUrl);
    await see(w, page, "This request was already approved");
    await shoot(w, page, "connect-used-approved");

    // Deny.
    w.step("connect-deny");
    const shop2 = "qa-deny.myshopify.com";
    const c2 = await app("/connect", { shop: shop2 });
    await page.goto(c2.approveUrl);
    await page.getByRole("button", { name: "Deny" }).click();
    await see(w, page, "Denied. Nothing was connected, and Shopify has been told.");
    await shoot(w, page, "connect-denied", { keys: true });
    const p2 = await app("/poll", { shop: shop2 });
    if (p2.connection?.state !== "none") w.note(`after Deny the app reads ${JSON.stringify(p2.connection)}`);
    const s2 = await app("/state", { shop: shop2 });
    if (Object.entries(s2.row || {}).some(([k, v]) => /key/i.test(k) && v === "[held]")) w.note("the app kept a key after Deny");
    if ((await keysFor(ctx.troothId, shop2)).length) w.note("a denied store has a connector key");

    // Abandoned: the request expires (15 minutes; moved on in the Worker's row and the app's clock).
    w.step("connect-expired");
    const shop3 = "qa-expired.myshopify.com";
    const c3 = await app("/connect", { shop: shop3 });
    const sid3 = c3.approveUrl.split("/").pop();
    await d1("UPDATE semanto_connect_sessions SET expires_at = ? WHERE session_id = ?", new Date(Date.now() - 60_000).toISOString(), sid3);
    w.expect(410, /\/connect\//);
    await page.goto(c3.approveUrl);
    await see(w, page, "This request has expired");
    await shoot(w, page, "connect-expired", { keys: true });
    await app("/advance", { ms: 16 * 60_000 });
    const v3 = await app("/view", { shop: shop3 });
    if (v3.connection?.state !== "none") w.note(`after expiry the app reads ${JSON.stringify(v3.connection)}`);
    if ((await keysFor(ctx.troothId, shop3)).length) w.note("an expired request left a connector key");
    await app("/advance", { ms: -16 * 60_000 }); // the app's clock back to the Worker's

    // Abandoned: the merchant closed the window (never approved), then came back later.
    w.step("connect-window-closed");
    const shop4 = "qa-closed.myshopify.com";
    const c4 = await app("/connect", { shop: shop4 });
    const again = await app("/connect", { shop: shop4 });
    if (again.approveUrl !== c4.approveUrl) w.note("pressing Connect again while a request is open made a second request");
    await d1("UPDATE semanto_connect_sessions SET expires_at = ? WHERE session_id = ?", new Date(Date.now() - 60_000).toISOString(), c4.approveUrl.split("/").pop());
    await app("/advance", { ms: 16 * 60_000 });
    const v4 = await app("/view", { shop: shop4 });
    if (v4.connection?.state !== "none") w.note(`a closed window left the app at ${JSON.stringify(v4.connection)}`);
    if ((await keysFor(ctx.troothId, shop4)).length) w.note("a closed window left a connector key");
    await app("/advance", { ms: -16 * 60_000 });

    // Abandoned: uninstalled before approval; the approve page then refuses the request.
    w.step("connect-uninstall-pending");
    const shop5 = "qa-uninstall.myshopify.com";
    const c5 = await app("/connect", { shop: shop5 });
    const u5 = await app("/uninstall", { shop: shop5 });
    if (!u5.gone) w.note("uninstall before approval kept the shop's rows");
    await page.goto(c5.approveUrl);
    await page.waitForSelector("main h1");
    // The app's signed uninstall withdrew the request: its own state, never "denied", and nothing to approve.
    await see(w, page, "This request was withdrawn");
    await see(w, page, "The store withdrew this request. Nothing was connected.");
    if (await page.getByRole("button", { name: "Approve" }).count()) w.note("a withdrawn request still offers Approve");
    if (await page.getByText(/already denied/).count()) w.note("a withdrawn request reads as denied");
    if (!(await page.getByRole("link", { name: "Back to Semanto" }).count())) w.note("a withdrawn request has no Back to Semanto");
    const back5 = await page.getByRole("link", { name: "Return to Shopify" }).getAttribute("href").catch(() => null);
    if (back5 !== `https://${shop5}/admin/apps/semanto-by-trooth`) w.note(`a withdrawn request's Return to Shopify links to ${back5}`);
    await shoot(w, page, "connect-withdrawn", { keys: true });
    const s5 = (await d1("SELECT state FROM semanto_connect_sessions WHERE session_id = ?", c5.approveUrl.split("/").pop()))[0]?.state;
    if (s5 !== "withdrawn") w.note(`the uninstalled app's request is ${s5}, not withdrawn`);
    const k5 = await keysFor(ctx.troothId, shop5);
    if (k5.some((k) => !k.revoked_at)) w.note("approving after the app was uninstalled left a live connector key with no app to hold it");

    // Unknown request.
    w.step("connect-unknown");
    w.expect(404, /\/connect\//);
    await page.goto(`${BASE}/dashboard/semanto/connect/cs_unknownrequest0000`);
    await see(w, page, "This request was not found");
    await shoot(w, page, "connect-not-found");

    // Disconnect in the app revokes the store key at Trooth.
    w.step("connect-disconnect");
    const d = await app("/disconnect", { shop });
    if (d.outcome !== "revoked") w.note(`Disconnect answered ${d.outcome}`);
    const after = await keysFor(ctx.troothId, shop);
    if (!after[0]?.revoked_at) w.note("Disconnect left the store key live at Trooth");
  } finally {
    child.kill();
  }
}
