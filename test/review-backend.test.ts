// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Regression tests for the backend review of 23 October 2026
// (docs/program/reports/review-backend.md). One test per finding (the finding
// number is in the test name) and one per enhancement, each failing on the
// code before the fix. In-memory ports (test/helpers/os-world.ts) and, for the
// D1 statements, Node's SQLite (test/fixtures/integration/fixture-d1-shim.ts).
// Google, worker-f and the company's site are fixtures; every figure is made up.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair } from "@/core/keys";
import { JWS_TYPES, signObject } from "@/core/jws";
import { canonicalize } from "@/core/canonical";
import { recallEventId } from "@/os/recalls";
import { signRecall, type RecallNoticeInput } from "@/commerce/recalls";
import { signProductRecord } from "@/commerce/product-record";
import { D1PipelineStore } from "@/db/d1";
import { D1OsStore } from "@/db/os-d1";
import { signPost, generateConnectorKey } from "../adapters/shared/sign-request.mjs";
import { FixtureD1, FixtureR2 } from "./fixtures/integration/fixture-d1-shim";
import { NOW, OS, buildAndSign, drain, get, json, osWorld, post, pub, purposeAssertion, type OsWorld } from "./helpers/os-world";

const AT = NOW.toISOString();
const SEAL = "fixture-seal-secret-of-forty-characters-x";
const catalogBody = readFileSync(new URL("./fixtures/integration/fixture-catalog.json", import.meta.url), "utf8");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const CONTENT = "https://www.googleapis.com/auth/content";
const BUSINESS = "https://www.googleapis.com/auth/business.manage";

async function postCatalog(w: OsWorld, privateJwk: Parameters<typeof signPost>[0]["privateJwk"], body = catalogBody): Promise<Response> {
  const url = `${OS}/acme/commerce/catalog`;
  const headers = await signPost({ url, body, privateJwk, created: Math.floor(w.clock.now.getTime() / 1000) });
  return w.app.request(url, { method: "POST", headers, body });
}

async function withCatalog(w: OsWorld): Promise<void> {
  const k = await generateConnectorKey();
  await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
  await postCatalog(w, k.privateJwk);
}

async function connectGoogle(w: OsWorld): Promise<void> {
  const scope = `${CONTENT} ${BUSINESS} openid https://www.googleapis.com/auth/userinfo.email`;
  w.google.on("https://oauth2.googleapis.com/token", (_u, init) => {
    const p = new URLSearchParams(init.body);
    if (p.get("grant_type") === "authorization_code") return { status: 200, body: JSON.stringify({ access_token: "fixture-access-1", refresh_token: "fixture-refresh-token", expires_in: 3599, scope, token_type: "Bearer", id_token: `${b64url("{}")}.${b64url(JSON.stringify({ email: "owner@acme.com" }))}.sig` }) };
    return { status: 200, body: JSON.stringify({ access_token: "fixture-access-2", expires_in: 3599, token_type: "Bearer" }) };
  });
  const start = await json(await post(w, "/acme/google/connect", { products: ["merchant", "business"] }));
  const url = new URL(start.authorization_url);
  expect((await pub(w, `/google/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=fixture-code`)).status).toBe(302);
}

async function writebackWorld(): Promise<OsWorld> {
  const w = await osWorld({ queue: true });
  await buildAndSign(w);
  await connectGoogle(w);
  await post(w, "/acme/company/surfaces", { add: { kind: "merchant_center", id: "accounts/123456", label: "Acme Store", data_source: "accounts/123456/dataSources/42" } });
  await post(w, "/acme/company/surfaces", { add: { kind: "business_profile", id: "locations/987", label: "Acme Inc" } });
  await withCatalog(w);
  const key = (await w.pipeline.d.keys.getCompanySigningKey("acme"))!;
  const record = await signProductRecord(
    { product_id: "601", sku: "ROC-200", brand: "Acme Inc", name: "Acme Rocket Skates", description: "Fixture skates.", attributes: [], regulatory: {}, media: [], url: "https://acme.com/products/skates", variant_axes: {}, provenance: "declared", evidence: { url: "https://acme.com/products/skates", witnessed_at: AT }, not_before: AT },
    key,
    { iat: NOW },
  );
  await w.commerce.putRecord("acme", record);
  return w;
}

const sendableIds = async (w: OsWorld): Promise<string[]> => (await json(await get(w, "/acme/writeback"))).payloads.filter((p: { sendable: boolean }) => p.sendable).map((p: { item_id: string }) => p.item_id);

const NOTICE: RecallNoticeInput = { skus: ["ANV-100"], issued_at: "2026-10-23T10:00:00.000Z", authority: { name: "U.S. Consumer Product Safety Commission", url: "https://www.cpsc.gov/Recalls/fixture" }, action: "stop_use", statement: "Stop using the Acme Anvil. It can fall.", url: "https://acme.com/recalls/anvil" };

function d1World() {
  const d1 = new FixtureD1();
  const r2 = new FixtureR2();
  return { d1, store: new D1PipelineStore(d1.asD1(), r2.asR2(), SEAL), os: new D1OsStore(d1.asD1(), r2.asR2()) };
}

// ------------------------------------------------------------------------ findings

describe("review findings, Semanto Worker", () => {
  it("finding 1: a company can store a recall (hosted with a passkey bound to the notice, customer with a JWS), and it reaches the changes feed", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    await withCatalog(w);
    expect((await post(w, "/acme/recalls", { notice: NOTICE }, "Bearer viewer-token")).status).toBe(403);
    // Without the passkey step nothing is signed or stored.
    expect((await json(await post(w, "/acme/recalls", { notice: NOTICE }))).code).toBe("passkey_cancelled");
    expect(await w.commerce.recalls("acme")).toEqual([]);
    // A bad notice names the problem.
    const bad = await post(w, "/acme/recalls/options", { notice: { ...NOTICE, url: "http://acme.com/recalls/anvil" } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).issues).toEqual(["url: https url."]);
    // An assertion for another notice does not count.
    const other = await purposeAssertion(w, { purpose: "recall", notice: { ...NOTICE, statement: "Something else." } });
    expect((await json(await post(w, "/acme/recalls", { notice: NOTICE, assertion: other }))).code).toBe("passkey_invalid");
    const assertion = await purposeAssertion(w, { purpose: "recall", notice: NOTICE });
    const r = await post(w, "/acme/recalls", { notice: NOTICE, assertion });
    expect([r.status, r.status === 201 ? "" : await r.clone().text()]).toEqual([201, ""]);
    const body = await json(r);
    expect(body).toMatchObject({ object: "semanto.recall", action: "stop_use", skus: ["ANV-100"], event: { state: "sent" } });
    expect((await w.commerce.recalls("acme")).map((x) => x.notice.id)).toEqual([body.recall_id]);
    expect(w.workerF.requests).toHaveLength(1);
    expect(JSON.parse(w.workerF.requests[0]!.body).recall.recall_id).toBe(body.recall_id);
    const list = await json(await get(w, "/acme/recalls", "Bearer viewer-token"));
    expect(list.recalls).toHaveLength(1);
    expect(list.recalls[0]).toMatchObject({ recall_id: body.recall_id, event: { state: "sent", event_id: await recallEventId("acme", (await w.commerce.recalls("acme"))[0]!.notice) } });
    expect(w.osStore.audit.filter((a) => a.action === "recalls.publish").map((a) => a.target)).toEqual([body.recall_id]);

    // Customer custody: the notice signed with the company's own key; a JWS by another key stores nothing.
    const c = await osWorld({ custody: "customer" });
    await withCatalog(c);
    const own = await generateKeyPair();
    await post(c, "/acme/keys/rotate", { public_jwk: own.publicJwk });
    const stranger = await generateKeyPair();
    const forged = await signRecall(NOTICE, { ...stranger.privateJwk, kid: own.publicJwk.kid }, { iat: NOW });
    expect((await json(await post(c, "/acme/recalls", { jws: forged.jws }))).code).toBe("signature_invalid");
    // Signed at the recall's issued_at, before the key was on file: refused with the hint to sign with iat now.
    expect((await json(await post(c, "/acme/recalls", { jws: (await signRecall(NOTICE, own.privateJwk)).jws }))).detail).toContain("iat set to the time you sign");
    const good = await signRecall(NOTICE, own.privateJwk, { iat: NOW });
    expect((await post(c, "/acme/recalls", { jws: good.jws })).status).toBe(201);
    expect((await post(c, "/acme/recalls", { jws: good.jws })).status).toBe(200);
    expect(c.osStore.audit.filter((a) => a.action === "recalls.publish")).toHaveLength(1);
  });

  it("finding 2: the one-call rotate cannot move a hosted company to a key the caller holds without the passkey", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const before = (await json(await get(w, "/acme/keys"))).keys.map((k: { kid: string }) => k.kid);
    const mine = await generateKeyPair();
    const r = await post(w, "/acme/keys/rotate", { public_jwk: mine.publicJwk });
    expect(r.status).toBe(409);
    expect((await json(r)).detail).toContain("keys/rotation/start");
    expect((await json(await get(w, "/acme/keys"))).keys.map((k: { kid: string }) => k.kid)).toEqual(before);
    expect((await w.store.getCompany("acme"))!.custody).toBe("hosted");
    // Rolling the hosted key Trooth keeps still works in one call, and so does a move between customer keys.
    expect((await post(w, "/acme/keys/rotate", {})).status).toBe(200);
    const c = await osWorld({ custody: "customer" });
    expect((await post(c, "/acme/keys/rotate", { public_jwk: (await generateKeyPair()).publicJwk })).status).toBe(200);
  });

  it("finding 3: a connector kid is registered once; it never moves to another company and a revoked one never comes back", async () => {
    const { d1, store } = d1World();
    for (const id of ["acme", "other"]) await store.putCompany({ trooth_id: id, domain: `${id}.com`, org: id, tier: "full", legal_name: id, current_version: null, custody: "hosted", domain_proven_at: AT, os_company_id: `co-${id}` });
    const k = await generateKeyPair();
    expect(await store.putConnectorKey("acme", k.publicJwk, "shopify:a.myshopify.com", AT, "Shop")).toBe(true);
    d1.db.prepare("UPDATE semanto_connector_keys SET revoked_at = ? WHERE kid = ?").run(AT, k.publicJwk.kid);
    expect(await store.putConnectorKey("other", k.publicJwk, "api", AT, null)).toBe(false);
    expect(d1.db.prepare("SELECT trooth_id, revoked_at FROM semanto_connector_keys WHERE kid = ?").get(k.publicJwk.kid)).toEqual({ trooth_id: "acme", revoked_at: AT });
    // Through the routes: a revoked key pasted again is refused and stays revoked.
    const w = await osWorld();
    const ck = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: ck.publicJwk });
    await post(w, `/acme/connectors/${ck.publicJwk.kid}/revoke`, { confirm: ck.publicJwk.kid });
    expect((await post(w, "/acme/connectors", { public_jwk: ck.publicJwk })).status).toBe(409);
    expect((await json(await get(w, "/acme/connectors"))).keys[0].revoked_at).toBe(AT);
  });

  it("finding 4: a recall kept as failed because no product record matched is sent when it is stored again after the record arrives", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const signed = await signRecall(NOTICE, (await w.pipeline.d.keys.getCompanySigningKey("acme"))!);
    await w.commerce.putRecall("acme", signed);
    expect(w.workerF.requests).toHaveLength(0);
    expect([...w.osStore.recallEvents.values()][0]).toMatchObject({ state: "failed" });
    await withCatalog(w);
    await w.commerce.putRecall("acme", signed);
    expect(w.workerF.requests).toHaveLength(1);
    expect([...w.osStore.recallEvents.values()][0]).toMatchObject({ state: "sent", last_error: null });
    // Sent once: storing it a third time is a no-op.
    await w.commerce.putRecall("acme", signed);
    expect(w.workerF.requests).toHaveLength(1);
  });

  it("finding 5: adding a signing passkey and signing a version are audited and show under recent changes", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const recent = (await json(await get(w, "/acme/company"))).recent_changes.map((r: { action: string }) => r.action);
    expect(recent).toEqual(expect.arrayContaining(["passkeys.add", "versions.sign"]));
    expect(w.osStore.audit.find((a) => a.action === "versions.sign")).toMatchObject({ who: "Ada Owner", role: "owner", target: "v1" });
  });

  it("finding 6: two rotation starts at the same moment publish one next key; the database keeps one started rotation per company", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const [a, b] = await Promise.all([post(w, "/acme/keys/rotation/start", { custody: "hosted" }), post(w, "/acme/keys/rotation/start", { custody: "hosted" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await json(await get(w, "/acme/keys"))).keys.filter((k: { state: string }) => k.state === "next")).toHaveLength(1);
    const { os } = d1World();
    const row = { rotation_id: "rot_1", trooth_id: "acme", next_kid: "n1", current_kid: "c", custody: "hosted" as const, state: "started" as const, overlap_until: null, started_by: "u", started_at: AT, confirmed_at: null, cancelled_at: null };
    expect(await os.beginRotation(row)).toBe(true);
    expect(await os.beginRotation({ ...row, rotation_id: "rot_2", next_kid: "n2" })).toBe(false);
    expect(await os.settleRotation("rot_1", "cancelled", AT, null)).toBe(true);
    expect(await os.beginRotation({ ...row, rotation_id: "rot_3", next_kid: "n3" })).toBe(true);
  });

  it("finding 7: an idempotency key reused with other items is refused, not answered with the earlier run", async () => {
    const w = await writebackWorld();
    const ids = await sendableIds(w);
    expect((await post(w, "/acme/writeback/send", { item_ids: [ids[0]], confirm: true, idempotency_key: "send-reuse-1" })).status).toBe(202);
    const reused = await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true, idempotency_key: "send-reuse-1" });
    expect(reused.status).toBe(409);
    expect((await json(reused)).detail).toContain("other items");
    expect(w.queued).toHaveLength(1);
    expect((await post(w, "/acme/writeback/send", { item_ids: [ids[0]], confirm: true, idempotency_key: "send-reuse-1" })).status).toBe(200);
  });

  it("finding 8: a run that loses the idempotency race in D1 leaves no items behind, and a visible run always has its items", async () => {
    const { d1, os } = d1World();
    const item = (run_id: string, item_id: string) => ({ run_id, item_id, trooth_id: "acme", connector: "business_profile" as const, target: "locations/1", summary: "s", request: { method: "PATCH" as const, url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/1", body: "{}", image_links: [] }, state: "queued" as const, attempts: 0, last_error: null, sent_at: null, updated_at: AT });
    const first = await os.createWritebackRun({ run_id: "wbr_a", trooth_id: "acme", idempotency_key: "key-0001", created_by: "u", created_at: AT }, [item("wbr_a", "wbi_1"), item("wbr_a", "wbi_2")]);
    expect(first.created).toBe(true);
    const lost = await os.createWritebackRun({ run_id: "wbr_b", trooth_id: "acme", idempotency_key: "key-0001", created_by: "u", created_at: AT }, [item("wbr_b", "wbi_1")]);
    expect(lost).toMatchObject({ created: false, run: { run_id: "wbr_a" } });
    expect(d1.db.prepare("SELECT COUNT(*) AS n FROM semanto_writeback_items WHERE run_id = 'wbr_b'").get()).toEqual({ n: 0 });
    expect((await os.writebackItems("wbr_a")).map((i) => i.item_id)).toEqual(["wbi_1", "wbi_2"]);
  });

  it("finding 9: two retries of a failed item at once queue it once", async () => {
    const w = await writebackWorld();
    w.google.on("https://merchantapi.googleapis.com/products/v1/", () => ({ status: 400, body: JSON.stringify({ error: { message: "Invalid data source." } }) }));
    const ids = await sendableIds(w);
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: [ids[0]], confirm: true, idempotency_key: "send-retry-1" }));
    await drain(w);
    expect((await json(await get(w, `/acme/writeback/runs/${run.run_id}`))).items[0].state).toBe("failed");
    const [a, b] = await Promise.all([post(w, `/acme/writeback/runs/${run.run_id}/retry`, { item_ids: [ids[0]] }), post(w, `/acme/writeback/runs/${run.run_id}/retry`, { item_ids: [ids[0]] })]);
    expect([a.status, b.status].filter((s) => s === 202).length).toBeGreaterThanOrEqual(1);
    expect(w.queued.filter((m) => (m as { kind?: string }).kind === "writeback")).toHaveLength(1);
    expect(w.osStore.audit.filter((x) => x.action === "writeback.retry")).toHaveLength(1);
  });

  it("finding 10: the Google token is sent only to the Merchant API and the Business Profile API", async () => {
    const w = await writebackWorld();
    const ids = await sendableIds(w);
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: [ids[0]], confirm: true, idempotency_key: "send-host-1" }));
    // A stored item whose address is not Google's (an old row, a bad target) is failed without a request.
    const key = `${run.run_id}\n${ids[0]}`;
    const stored = w.osStore.items.get(key)!;
    w.osStore.items.set(key, { ...stored, request: { ...stored.request, url: "https://collector.example/steal" } });
    w.google.calls.length = 0;
    await drain(w);
    expect(w.google.calls).toEqual([]);
    expect((await json(await get(w, `/acme/writeback/runs/${run.run_id}`))).items[0]).toMatchObject({ state: "failed", last_error: expect.stringContaining("not addressed to the Merchant API") });
  });

  it("finding 13: adding the same alert address twice at once sends one confirmation", async () => {
    const w = await osWorld();
    const [a, b] = await Promise.all([post(w, "/acme/company/alerts", { add: "ops@acme.com" }), post(w, "/acme/company/alerts", { add: "ops@acme.com" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(w.emails).toHaveLength(1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(w.emails[0]!.text)![1]!;
    expect((await pub(w, `/alerts/confirm?token=${token}`)).headers.get("location")).toContain("alerts=confirmed");
  });

  it("finding 14: the settings answer keeps the last save time however many other writes came after it", async () => {
    const w = await osWorld();
    await post(w, "/acme/settings", { content_signals: { "ai-train": false, search: true, "ai-input": true } });
    for (let i = 0; i < 250; i++) await w.osStore.appendAudit({ trooth_id: "acme", actor: "u", who: "x", role: "owner", action: "company.surfaces.add", target: "t", before_hash: null, after_hash: null, request_id: "r", at: "2026-10-23T13:00:00.000Z" });
    expect((await json(await get(w, "/acme/settings"))).updated_at).toBe(AT);
    const { os } = d1World();
    await os.appendAudit({ trooth_id: "acme", actor: "u", who: "x", role: "owner", action: "settings.save", target: "delivery", before_hash: null, after_hash: null, request_id: "r", at: AT });
    await os.appendAudit({ trooth_id: "acme", actor: "u", who: "x", role: "owner", action: "keys.revoke", target: "k", before_hash: null, after_hash: null, request_id: "r", at: "2026-10-23T14:00:00.000Z" });
    expect((await os.lastAudit("acme", "settings.save"))?.at).toBe(AT);
  });

  it("finding 15: a lower seller list version that lands after a higher one is refused, in memory and in D1", async () => {
    const w = await osWorld({ custody: "customer" });
    const k = await generateKeyPair();
    await post(w, "/acme/keys/rotate", { public_jwk: k.publicJwk });
    const list = (version: number) => ({ trooth_id: "acme", version, issued_at: AT, sellers: [{ seller_id: "s-1", name: "Fixture Outlet", domain: "outlet.example", authorized_from: "2026-01-01T00:00:00.000Z" }] });
    const row = (version: number) => ({ trooth_id: "acme", version, jws: "a.b.c", kid: k.publicJwk.kid, issued_at: AT, payload: list(version), custody: "customer" as const, submitted_by: "u", submitted_at: AT });
    // The higher version lands between the lower one's check and its insert.
    expect(await w.osStore.putSellerList(row(6))).toBe(true);
    expect(await w.osStore.putSellerList(row(5))).toBe(false);
    const r = await post(w, "/acme/sellers/lists", { jws: (await signObject(list(5), k.privateJwk, JWS_TYPES.sellerList, { iat: NOW })).compact });
    expect(r.status).toBe(409);
    const { os } = d1World();
    expect(await os.putSellerList(row(6))).toBe(true);
    expect(await os.putSellerList(row(5))).toBe(false);
    expect(await os.putSellerList(row(6))).toBe(false);
    expect(await os.putSellerList(row(7))).toBe(true);
  });

  it("finding 16: a connector revoked twice at once is revoked and audited once", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    const [a, b] = await Promise.all([post(w, `/acme/connectors/${k.publicJwk.kid}/revoke`, { confirm: k.publicJwk.kid }), post(w, `/acme/connectors/${k.publicJwk.kid}/revoke`, { confirm: k.publicJwk.kid })]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(w.osStore.audit.filter((x) => x.action === "connectors.revoke")).toHaveLength(1);
  });

  it("finding 17: requests naming an app's kid from another address do not use up that app's uninstall bucket", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    const junk = (ip: string) => w.app.request("https://api.trooth.co/public/semanto/connect/uninstall", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, "signature-input": `sig1=("@method");created=1;keyid="${k.publicJwk.kid}";tag="trooth-connector"`, signature: "sig1=:AAAA:" }, body: "{}" });
    for (let i = 0; i < 10; i++) await junk("198.51.100.66");
    expect((await junk("198.51.100.66")).status).toBe(429);
    // The app's own server, on its own address, is still answered (404 here: the key was never registered).
    expect((await junk("203.0.113.9")).status).toBe(404);
  });

  it("finding 19: approving the same connect request twice for the same company answers the same approval", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    const s = await json(await pub(w, "/connect/sessions", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ app: "shopify", account: "acme-store.myshopify.com", public_jwk: k.publicJwk }) }));
    const first = await post(w, `/acme/connect/${s.session_id}/approve`, {});
    const again = await post(w, `/acme/connect/${s.session_id}/approve`, {});
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await json(again)).toMatchObject({ state: "approved", kid: k.publicJwk.kid });
    expect(w.osStore.audit.filter((a) => a.action === "connect.approve")).toHaveLength(1);
    expect((await post(w, `/acme/connect/${s.session_id}/deny`, {})).status).toBe(409);
  });
});

describe("migration 0008 and its down file", () => {
  it("adds the two indexes, the down file removes exactly them, and 0008 applies again", () => {
    const { d1 } = d1World();
    const indexes = () => (d1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('semanto_key_rotations_started', 'semanto_audit_action') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(indexes()).toEqual(["semanto_audit_action", "semanto_key_rotations_started"]);
    d1.db.exec(readFileSync(new URL("../migrations-down/0008_review_backend.down.sql", import.meta.url), "utf8"));
    expect(indexes()).toEqual([]);
    d1.db.exec(readFileSync(new URL("../migrations/0008_review_backend.sql", import.meta.url), "utf8"));
    expect(indexes()).toEqual(["semanto_audit_action", "semanto_key_rotations_started"]);
  });
});

describe("migration 0009 (connect requests can be withdrawn) and its down file", () => {
  it("the table takes withdrawn, D1 withdraws only a pending request, and the down file turns withdrawn back into denied", async () => {
    const { d1, os } = d1World();
    const base = { poll_token_hash: "h", app: "shopify", account: "a.myshopify.com", public_jwk: { kty: "OKP", crv: "Ed25519", x: "x", kid: "k1" } as never, kid: "k1", return_url: null, state: "pending" as const, trooth_id: null, requested_at: AT, expires_at: AT, decided_at: null, decided_by: null };
    await os.putConnectSession({ ...base, session_id: "cs_1" });
    expect((await os.pendingConnectSessionByKid("k1"))?.session_id).toBe("cs_1");
    expect(await os.withdrawConnectSession("cs_1", "app:shopify", AT)).toBe(true);
    expect(await os.withdrawConnectSession("cs_1", "app:shopify", AT)).toBe(false);
    expect((await os.getConnectSession("cs_1"))?.state).toBe("withdrawn");
    expect(await os.pendingConnectSessionByKid("k1")).toBeNull();
    d1.db.exec(readFileSync(new URL("../migrations-down/0009_connect_withdrawn.down.sql", import.meta.url), "utf8"));
    expect((d1.db.prepare("SELECT state FROM semanto_connect_sessions WHERE session_id = 'cs_1'").get() as { state: string }).state).toBe("denied");
    d1.db.exec(readFileSync(new URL("../migrations/0009_connect_withdrawn.sql", import.meta.url), "utf8"));
    expect(await os.withdrawConnectSession("cs_1", "app:shopify", AT)).toBe(false);
  });
});

// ------------------------------------------------------------------------ enhancements

describe("review enhancements, Semanto Worker", () => {
  it("write-back: the Google access token is reused across a run's items (one refresh), and a 401 drops it", async () => {
    const w = await writebackWorld();
    w.google.on("https://merchantapi.googleapis.com/products/v1/", () => ({ status: 200, body: "{}" }));
    w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987", () => ({ status: 200, body: "{}" }));
    const refreshes = () => w.google.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token" && new URLSearchParams(c.init.body).get("grant_type") === "refresh_token").length;
    const before = refreshes();
    await post(w, "/acme/writeback/send", { item_ids: await sendableIds(w), confirm: true, idempotency_key: "send-cache-1" });
    await drain(w);
    expect(refreshes() - before).toBe(1);
    w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987", () => ({ status: 401, body: JSON.stringify({ error: { message: "Request had invalid authentication credentials." } }) }));
    const bp = (await json(await get(w, "/acme/writeback"))).payloads.find((p: { connector: string; sendable: boolean }) => p.connector === "business_profile").item_id;
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: [bp], confirm: true, idempotency_key: "send-cache-2" }));
    await expect(w.pipeline.jobs().compile(w.queued.shift(), 1)).rejects.toMatchObject({ delaySeconds: 30 });
    expect(w.os.googleTokens.has("acme")).toBe(false);
    expect((await json(await get(w, `/acme/writeback/runs/${run.run_id}`))).items[0].state).toBe("retrying");
  });

  it("write-back: send without item_ids sends every sendable change; retry without item_ids sends every failed item; runs carry counts", async () => {
    const w = await writebackWorld();
    const ids = await sendableIds(w);
    const run = await json(await post(w, "/acme/writeback/send", { confirm: true, idempotency_key: "send-all-1" }));
    expect(run.items.map((i: { item_id: string }) => i.item_id)).toEqual(ids);
    w.google.on("https://merchantapi.googleapis.com/products/v1/", () => ({ status: 400, body: JSON.stringify({ error: { message: "Invalid data source." } }) }));
    w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987", () => ({ status: 200, body: "{}" }));
    await drain(w);
    const detail = await json(await get(w, `/acme/writeback/runs/${run.run_id}`));
    expect(detail.counts).toMatchObject({ sent: 1, failed: 1 });
    const retried = await json(await post(w, `/acme/writeback/runs/${run.run_id}/retry`, {}));
    expect(retried.counts).toMatchObject({ sent: 1, queued: 1 });
    expect((await json(await get(w, "/acme/writeback/runs"))).runs[0].counts).toMatchObject({ sent: 1, queued: 1 });
    expect((await json(await post(w, `/acme/writeback/runs/${run.run_id}/retry`, {}))).code).toBe("conflict");
  });

  it("connect: the session answers interval (RFC 8628) while pending; the connector test says what to do next", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    const s = await json(await pub(w, "/connect/sessions", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ app: "shopify", account: "acme-store.myshopify.com", public_jwk: k.publicJwk }) }));
    expect(s.interval).toBe(2);
    expect((await json(await pub(w, `/connect/sessions/${s.session_id}`, { headers: { authorization: `Bearer ${s.poll_token}` } }))).interval).toBe(2);
    const c = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: c.publicJwk });
    expect((await json(await post(w, `/acme/connectors/${c.publicJwk.kid}/test`, {}))).advice).toContain("has not received a signed request");
  });

  it("keys: a started rotation shows the new key's DNS record on every read; seller lists answer next_version; pending alerts say when resend opens", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "hosted" }));
    expect((await json(await get(w, "/acme/keys"))).rotation.dns_record).toEqual(started.dns_record);
    expect((await json(await get(w, "/acme/sellers/lists"))).next_version).toBe(1);
    await post(w, "/acme/company/alerts", { add: "ops@acme.com" });
    expect((await json(await get(w, "/acme/company"))).alert_addresses[0].resend_available_at).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(canonicalize({ a: 1 })).toBe('{"a":1}');
  });
});
