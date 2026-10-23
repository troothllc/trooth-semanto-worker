// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: recalls into worker-f's changes feed. recallsHosted: the form with
// every invalid field, Review and Back, Publish with the signing passkey
// (double clicked), the recall reaching worker-f through the TROOTH_OS
// stand-in and seen exactly once by polling both feeds (GET /v1/facts/changes
// and MCP trooth_company_changes); the same event sent twice (stored once,
// seen once); a recall for a product with no record (not in the feed, with the
// reason), fixed and sent again; a recall published while worker-f is down,
// retried by the queue and delivered once when it is back.
// recallsCustomer: a notice signed with the company's own key, uploaded.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { load, shoot, see, control, d1, d1f, STACK } from "./lib.mjs";
import { posts } from "./delivery.mjs";
import { sendCatalog } from "./connectors.mjs";
import { compactJws, TYPES } from "./jws.mjs";

const recallsView = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/recalls`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));
const feedRest = (cursor) => control("/feed/rest", { query: cursor ? `?cursor=${encodeURIComponent(cursor)}` : "" }).then((r) => r.body);
const feedMcp = (args) => control("/feed/mcp", { args }).then((r) => r.body?.result?.structuredContent ?? r.body);

async function fillRecall(page, v) {
  const f = page.locator("form", { has: page.getByLabel("Statement") });
  if (v.skus !== undefined) await f.getByLabel("SKUs").fill(v.skus);
  if (v.gtins !== undefined) await f.getByLabel("GTINs").fill(v.gtins);
  if (v.action) await f.getByRole("radio", { name: new RegExp(v.action) }).check();
  if (v.statement !== undefined) await f.getByLabel("Statement").fill(v.statement);
  if (v.url !== undefined) await f.getByLabel("Notice on your site").fill(v.url);
  if (v.date !== undefined) await f.getByLabel("Announced on").fill(v.date);
  if (v.authorityName !== undefined) await f.getByLabel("Name", { exact: true }).fill(v.authorityName);
  if (v.authorityUrl !== undefined) await f.getByLabel("Its recall page").fill(v.authorityUrl);
}

async function waitFeed(ctx, recallId, want, tries = 40) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = (await recallsView(ctx)).recalls?.find((x) => x.recall_id === recallId || x.id === recallId);
    if (r?.event?.state === want) return r;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return r;
}

export async function recallsHosted(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  // The feeds before anything is published: the cursors the agents hold.
  const rest0 = await feedRest();
  const mcp0 = await feedMcp({ company: STACK.companies.acme.domain });
  if (!rest0?.next_cursor) w.note(`GET /v1/facts/changes answered ${JSON.stringify(rest0).slice(0, 200)}`);
  if (!mcp0?.changes?.recall_cursor) w.note(`trooth_company_changes answered ${JSON.stringify(mcp0).slice(0, 300)}`);

  await load(w, page, "/dashboard/semanto/recalls", "recalls-empty");
  await see(w, page, "No recalls published");
  await shoot(w, page, "recalls-empty", { keys: true });

  // Every invalid field.
  w.step("recalls-invalid");
  await page.getByRole("radio", { name: /Write the notice here/ }).check();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await see(w, page, "Name at least one SKU or one GTIN.");
  await see(w, page, "Fix the fields marked above, then review again.");
  await fillRecall(page, { gtins: "00012345678906", statement: "x".repeat(1001), url: "http://acmegoods-qa.com/recalls/kettle", date: tomorrow, authorityName: "U.S. Consumer Product Safety Commission", authorityUrl: "" });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await see(w, page, "One of these is not a GTIN: check its length and its last digit.");
  await see(w, page, "This is too long.");
  await see(w, page, "Enter an https address, like https://acme.com/recalls.");
  await see(w, page, "A recall cannot be announced in the future.");
  await see(w, page, "Give the authority's name and its recall page, or neither.");
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  if (!focused) w.note("focus did not move to the first field to fix");
  await shoot(w, page, "recalls-invalid", { keys: true });

  // A valid notice: Review, Back keeps it, Review, Publish (double clicked).
  w.step("recalls-review");
  const statement = "The Classic Kettle handle can come loose while pouring hot water. Stop using it and ask Acme Goods for a free replacement.";
  await fillRecall(page, { skus: "KET-001", gtins: "00012345678905", action: "Stop using it", statement, url: "https://acmegoods-qa.com/recalls/kettle", date: today, authorityName: "U.S. Consumer Product Safety Commission", authorityUrl: "https://www.cpsc.gov/Recalls/2026/qa-kettle" });
  await see(w, page, "Agents see this as the title: The Classic Kettle handle can come loose while pouring hot water.");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await see(w, page, "Publishing a recall is public and lasting.");
  await shoot(w, page, "recalls-review", { keys: true });
  await page.getByRole("button", { name: "Back" }).click();
  if ((await page.getByLabel("Statement").inputValue()) !== statement) w.note("Back from Review lost the statement");
  const notices = [];
  page.on("request", (r) => { if (/\/api\/semanto\/[^/]+\/recalls\/options$/.test(r.url())) try { notices.push(JSON.parse(r.postData()).notice); } catch {} });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  w.step("recalls-publish");
  await page.getByRole("button", { name: /^(Sign with my passkey and publish|Publish this recall)$/ }).last().dblclick();
  await see(w, page, /Published: The Classic Kettle handle/);
  await page.waitForTimeout(600);
  if (posts(w, /\/recalls$/).length !== 1) w.note(`a double click on Publish sent ${posts(w, /\/recalls$/).length} recalls`);
  ctx.recallNotice = notices[0];
  const r1 = (await recallsView(ctx)).recalls?.[0];
  const sent = await waitFeed(ctx, r1?.recall_id ?? r1?.id, "sent");
  if (sent?.event?.state !== "sent") w.note(`the recall's feed state is ${JSON.stringify(sent?.event)}`);
  await load(w, page, "/dashboard/semanto/recalls", "recalls-in-feed");
  await see(w, page, "In the feed");
  await shoot(w, page, "recalls-in-feed", { keys: true });

  // worker-f stored it once; both feeds show it once after the agents' cursors.
  w.step("recalls-feeds");
  const stored = await d1f("SELECT event_id, recall_id, provenance FROM semanto_recall_changes");
  if (stored.length !== 1) w.note(`worker-f holds ${stored.length} recall changes after one publish`);
  if (stored[0] && stored[0].provenance !== "public_record") w.note(`a recall with an authority reached the feed as ${stored[0].provenance}`);
  const rest1 = await feedRest(rest0?.next_cursor);
  if (rest1?.recalls?.length !== 1) w.note(`GET /v1/facts/changes after the cursor shows ${rest1?.recalls?.length} recalls`);
  const mcp1 = await feedMcp({ company: STACK.companies.acme.domain, recall_cursor: mcp0?.changes?.recall_cursor });
  if (mcp1?.changes?.recalls?.length !== 1) w.note(`trooth_company_changes after the cursor shows ${mcp1?.changes?.recalls?.length} recalls`);
  const other = await feedMcp({ company: STACK.companies.globex.domain });
  if (other?.changes?.recalls?.length) w.note("another company's record carries the recall");

  // The same event twice: worker-f stores it once and the feeds show it once.
  w.step("recalls-duplicate");
  const ev = (await d1("SELECT event_id, body_json AS body FROM semanto_recall_events WHERE trooth_id = ?", ctx.troothId))[0];
  const secret = JSON.parse(readFileSync(new URL("../.run/secrets.json", import.meta.url), "utf8")).SEMANTO_EVENTS_SECRET;
  const body = ev?.body ?? "";
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const replay = await fetch(`${STACK.control}/replay-recall`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, signature: sig }) }).then((r) => r.json());
  if (replay.status !== 200 || replay.body?.duplicate !== true) w.note(`the same event sent again answered ${JSON.stringify(replay).slice(0, 200)}`);
  if ((await d1f("SELECT event_id FROM semanto_recall_changes")).length !== 1) w.note("the repeated event was stored twice");
  const rest2 = await feedRest(rest1?.next_cursor);
  if (rest2?.recalls?.length) w.note("the repeated event appeared in the feed again");

  // A recall for a product with no record: not in the feed, with the reason; the record arrives; Send again.
  w.step("recalls-no-record");
  await load(w, page, "/dashboard/semanto/recalls", "recalls-no-record");
  await page.getByRole("radio", { name: /Write the notice here/ }).check();
  await fillRecall(page, { skus: "MUG-404", action: "Return it", statement: "The Travel Mug lid can crack. Return it for a refund.", url: "https://acmegoods-qa.com/recalls/mug", date: today });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /^(Sign with my passkey and publish|Publish this recall)$/ }).last().click();
  await see(w, page, /Published: The Travel Mug lid can crack/);
  await page.waitForTimeout(1500);
  await load(w, page, "/dashboard/semanto/recalls", "recalls-not-in-feed");
  await see(w, page, "Not in the feed");
  await shoot(w, page, "recalls-not-in-feed", { keys: true });
  await sendCatalog(ctx.troothId, ctx.edgeConnector, { products: [{ sku: "MUG-404", name: "Travel Mug", url: `https://${STACK.companies.acme.domain}/products/mug`, price: "19.00", stock_status: "instock" }] });
  await page.getByRole("button", { name: /^Send again, the recall / }).click();
  await see(w, page, "Signed again and sent.");
  const mug = (await recallsView(ctx)).recalls?.find((r) => r.skus?.includes("MUG-404") || JSON.stringify(r).includes("MUG-404"));
  const mugSent = await waitFeed(ctx, mug?.recall_id ?? mug?.id, "sent");
  if (mugSent?.event?.state !== "sent") w.note(`after Send again the recall is ${JSON.stringify(mugSent?.event)}`);

  // worker-f down while a recall is published: the queue keeps trying; back up, it is delivered once.
  w.step("recalls-workerf-down");
  await control("/mode", { workerf: "down" });
  await load(w, page, "/dashboard/semanto/recalls", "recalls-workerf-down");
  await page.getByRole("radio", { name: /Write the notice here/ }).check();
  await fillRecall(page, { skus: "TEA-002", action: "Stop selling it", statement: "The Stone Teapot glaze failed a lead test. Stop selling it until further notice.", url: "https://acmegoods-qa.com/recalls/teapot", date: today });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /^(Sign with my passkey and publish|Publish this recall)$/ }).last().click();
  await see(w, page, /Published: The Stone Teapot glaze failed a lead test/);
  await page.waitForTimeout(2000);
  await load(w, page, "/dashboard/semanto/recalls", "recalls-being-sent");
  await see(w, page, "Being sent");
  await shoot(w, page, "recalls-being-sent", { keys: true });
  await control("/mode", { workerf: "up" });
  const tea = (await recallsView(ctx)).recalls?.find((r) => JSON.stringify(r).includes("TEA-002"));
  const teaSent = await waitFeed(ctx, tea?.recall_id ?? tea?.id, "sent", 90);
  if (teaSent?.event?.state !== "sent") w.note(`after worker-f came back the recall is ${JSON.stringify(teaSent?.event)}`);
  const rest3 = await feedRest(rest1?.next_cursor);
  const ids = (rest3?.recalls ?? []).map((r) => r.recall_id);
  if (new Set(ids).size !== ids.length || ids.length !== 2) w.note(`after the outage the REST feed shows ${JSON.stringify(ids)}`);
  const mcp3 = await feedMcp({ company: STACK.companies.acme.domain, recall_cursor: mcp1?.changes?.recall_cursor });
  if (mcp3?.changes?.recalls?.length !== 2) w.note(`after the outage the MCP feed shows ${mcp3?.changes?.recalls?.length} new recalls`);
}

export async function recallsCustomer(w, ctx) {
  const page = ctx.ownerPage;
  const dir = `${w.out}/files`;
  mkdirSync(dir, { recursive: true });
  await load(w, page, "/dashboard/semanto/recalls", "recalls-customer");
  await see(w, page, "Your company holds its own key, so Trooth cannot sign for you.");
  const draft = { ...(ctx.recallNotice ?? {}), statement: "The Classic Kettle lid hinge can break. Stop selling it.", action: "stop_sale", issued_at: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  delete draft.id;
  delete draft.object;
  // Built as the Worker builds a notice (object and smn_ content id), then signed with the company's own key.
  const built = spawnSync(process.execPath, ["--import", "tsx", "qa/recall-notice.mts"], { cwd: new URL("../..", import.meta.url).pathname, input: JSON.stringify(draft), encoding: "utf8" });
  if (built.status !== 0) w.note(`the recall notice could not be built: ${built.stderr.slice(-300)}`);
  const notice = JSON.parse(built.stdout || "{}");
  // Without its object and id the dashboard names the problem before Publish (QA-18).
  const { id: _id, object: _object, ...bare } = notice;
  const write = (name, text) => { const p = `${dir}/${name}`; writeFileSync(p, text); return p; };
  await page.getByRole("radio", { name: /Upload a notice my company signed/ }).check();
  const input = page.getByLabel("Signed notice file");
  w.step("recalls-upload-invalid");
  await input.setInputFiles(write("wrong-type.jws", compactJws(notice, ctx.customerJwk, TYPES.sellerList)));
  await see(w, page, "This JWS is not a recall notice");
  await input.setInputFiles(write("no-id.jws", compactJws(bare, ctx.customerJwk, TYPES.recall)));
  await see(w, page, "The notice inside has no recall id.");
  await input.setInputFiles(write("future.jws", compactJws({ ...notice, issued_at: new Date(Date.now() + 3 * 86400_000).toISOString() }, ctx.customerJwk, TYPES.recall)));
  await see(w, page, "The notice is dated in the future.");
  await shoot(w, page, "recalls-upload-invalid", { keys: true });
  w.step("recalls-upload-good");
  await input.setInputFiles(write("notice.jws", compactJws(notice, ctx.customerJwk, TYPES.recall)));
  await see(w, page, /reads as a recall notice signed with key/);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /^(Sign with my passkey and publish|Publish this recall)$/ }).last().click();
  await see(w, page, /Published: The Classic Kettle lid hinge can break/);
  await shoot(w, page, "recalls-customer-published");
}
