// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The workspace contract's D1 side: migration 0007 applies after 0001 to 0006
// and its down file (migrations-down/0007_os_contract.down.sql) reverses it;
// src/db/os-d1.ts D1OsStore answers what MemoryOsStore answers, with every
// single-use value taken once; and a key staged as next never signs or sets
// the custody in src/db/d1.ts. Node's SQLite stands in for D1
// (test/fixtures/integration/fixture-d1-shim.ts).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@/core/keys";
import { D1CommerceStore, D1Keys, D1PipelineStore } from "@/db/d1";
import { D1OsStore } from "@/db/os-d1";
import { openText, sealText } from "@/db/key-seal";
import { FixtureD1, FixtureR2 } from "./fixtures/integration/fixture-d1-shim";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const DOWN = fileURLToPath(new URL("../migrations-down/", import.meta.url));
const AT = "2026-10-23T12:00:00.000Z";
const SEAL = "fixture-seal-secret-of-forty-characters-x";

function world() {
  const d1 = new FixtureD1();
  const r2 = new FixtureR2();
  const store = new D1PipelineStore(d1.asD1(), r2.asR2(), SEAL);
  const os = new D1OsStore(d1.asD1(), r2.asR2());
  return { d1, r2, store, os };
}

const tables = (d1: FixtureD1) => (d1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const columns = (d1: FixtureD1, t: string) => (d1.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);

describe("migration 0007 and its down file", () => {
  it("every migration from 0007 on has a down file in migrations-down/, outside wrangler's folder", () => {
    const ups = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) >= 7);
    expect(ups).toContain("0007_os_contract.sql");
    for (const up of ups) expect(readdirSync(DOWN)).toContain(up.replace(/\.sql$/, ".down.sql"));
  });

  it("applies after 0001 to 0006, and the down file removes exactly what it added, so 0007 applies again", () => {
    const { d1 } = world();
    const added = ["semanto_audit", "semanto_key_rotations", "semanto_connect_sessions", "semanto_google_states", "semanto_google_connections", "semanto_alert_addresses", "semanto_writeback_runs", "semanto_writeback_items", "semanto_seller_lists", "semanto_recall_events", "semanto_credentials"];
    for (const t of added) expect(tables(d1)).toContain(t);
    expect(columns(d1, "semanto_keys")).toContain("pending");
    expect(columns(d1, "semanto_connector_keys")).toEqual(expect.arrayContaining(["label", "last_request_at", "last_result", "last_ok_at"]));
    const before = tables(d1).filter((t) => !added.includes(t)).sort();
    d1.db.exec(readFileSync(`${DOWN}0007_os_contract.down.sql`, "utf8"));
    expect(tables(d1).sort()).toEqual(before);
    expect(columns(d1, "semanto_keys")).not.toContain("pending");
    expect(columns(d1, "semanto_connector_keys")).not.toContain("label");
    d1.db.exec(readFileSync(`${MIGRATIONS}0007_os_contract.sql`, "utf8"));
    expect(tables(d1)).toEqual(expect.arrayContaining(added));
  });
});

describe("D1OsStore", () => {
  it("takes single-use values once: the OAuth state, the alert token, the connect decision, the rotation settle", async () => {
    const { os } = world();
    await os.putGoogleState({ state_hash: "h1", trooth_id: "acme", user_id: "u", who: "Ada Owner", role: "owner", code_verifier: "v", products: ["merchant"], created_at: AT, expires_at: AT });
    expect(await os.takeGoogleState("h1")).toMatchObject({ trooth_id: "acme", role: "owner", products: ["merchant"] });
    expect(await os.takeGoogleState("h1")).toBeNull();
    await os.putAlertAddress({ trooth_id: "acme", address: "ops@acme.com", state: "pending", token_hash: "t1", token_expires_at: "2026-10-24T12:00:00.000Z", added_at: AT, confirmed_at: null, last_sent_at: AT });
    expect(await os.confirmAlertToken("t1", "2026-10-25T00:00:00.000Z")).toBeNull();
    expect(await os.confirmAlertToken("t1", AT)).toMatchObject({ address: "ops@acme.com", state: "confirmed", token_hash: null });
    expect(await os.confirmAlertToken("t1", AT)).toBeNull();
    const k = await generateKeyPair();
    await os.putConnectSession({ session_id: "cs_1", poll_token_hash: "p", app: "shopify", account: "a.myshopify.com", public_jwk: k.publicJwk, kid: k.publicJwk.kid, return_url: null, state: "pending", trooth_id: null, requested_at: AT, expires_at: AT, decided_at: null, decided_by: null });
    expect(await os.decideConnectSession("cs_1", "approved", "acme", "u", AT)).toBe(true);
    expect(await os.decideConnectSession("cs_1", "denied", "acme", "u", AT)).toBe(false);
    expect(await os.getConnectSession("cs_1")).toMatchObject({ state: "approved", trooth_id: "acme", public_jwk: k.publicJwk });
    expect(await os.beginRotation({ rotation_id: "rot_1", trooth_id: "acme", next_kid: "n", current_kid: "c", custody: "hosted", state: "started", overlap_until: null, started_by: "u", started_at: AT, confirmed_at: null, cancelled_at: null })).toBe(true);
    expect(await os.settleRotation("rot_1", "confirmed", AT, "2026-11-22T12:00:00.000Z")).toBe(true);
    expect(await os.settleRotation("rot_1", "cancelled", AT, null)).toBe(false);
    expect(await os.latestRotation("acme")).toMatchObject({ state: "confirmed", overlap_until: "2026-11-22T12:00:00.000Z" });
  });

  it("keeps the audit newest first, one run per idempotency key, versions that only insert once, events once, and credential totals", async () => {
    const { os, r2 } = world();
    for (let i = 0; i < 3; i++) await os.appendAudit({ trooth_id: "acme", actor: "u", who: "Ada Owner", role: "owner", action: `a${i}`, target: "t", before_hash: null, after_hash: null, request_id: "r", at: AT });
    expect((await os.recentAudit("acme", 2)).map((r) => r.action)).toEqual(["a2", "a1"]);
    const item = { run_id: "wbr_1", item_id: "wbi_1", trooth_id: "acme", connector: "business_profile" as const, target: "locations/1", summary: "s", request: { method: "PATCH" as const, url: "https://x", body: "{}", image_links: [] }, state: "queued" as const, attempts: 0, last_error: null, sent_at: null, updated_at: AT };
    expect((await os.createWritebackRun({ run_id: "wbr_1", trooth_id: "acme", idempotency_key: "key-0001", created_by: "u", created_at: AT }, [item])).created).toBe(true);
    const second = await os.createWritebackRun({ run_id: "wbr_2", trooth_id: "acme", idempotency_key: "key-0001", created_by: "u", created_at: AT }, [{ ...item, run_id: "wbr_2" }]);
    expect(second).toMatchObject({ created: false, run: { run_id: "wbr_1" } });
    expect(await os.writebackRunByKey("acme", "key-0001")).toMatchObject({ run_id: "wbr_1" });
    expect(await os.writebackRunByKey("acme", "key-0002")).toBeNull();
    await os.updateWritebackItem("wbr_1", "wbi_1", { state: "sent", attempts: 1, sent_at: AT }, AT);
    expect(await os.writebackItems("wbr_1")).toEqual([{ ...item, state: "sent", attempts: 1, sent_at: AT }]);
    const list = { trooth_id: "acme", version: 1, jws: "a.b.c", kid: "k", issued_at: AT, payload: { version: 1 }, custody: "customer" as const, submitted_by: "u", submitted_at: AT };
    expect(await os.putSellerList(list)).toBe(true);
    expect(await os.putSellerList(list)).toBe(false);
    expect(await os.sellerLists("acme")).toEqual([list]);
    const ev = { event_id: "sha256:1", trooth_id: "acme", recall_id: "smn_1", body: "{}", state: "queued" as const, attempts: 0, last_error: null, created_at: AT, sent_at: null };
    expect(await os.putRecallEvent(ev)).toBe(true);
    expect(await os.putRecallEvent(ev)).toBe(false);
    await os.updateRecallEvent("sha256:1", { state: "sent", attempts: 1, sent_at: AT });
    expect(await os.getRecallEvent("sha256:1")).toMatchObject({ state: "sent", attempts: 1 });
    await os.putCredential({ trooth_id: "acme", asset_url: "https://acme.com/a.png", sha256: "a".repeat(64), kind: "image/png", source: "compile", state: "made", reason: null, made_at: AT });
    await os.putCredential({ trooth_id: "acme", asset_url: "https://acme.com/b.png", sha256: null, kind: "image/png", source: "compile", state: "failed", reason: "no", made_at: AT });
    expect((await os.credentials("acme", { offset: 0, limit: 10 })).totals).toEqual({ made: 1, failed: 1, skipped: 0 });
    expect((await os.credentials("acme", { state: "made", offset: 0, limit: 10 })).rows).toHaveLength(1);
    expect(await os.credentialBySha("acme", "a".repeat(64))).toMatchObject({ asset_url: "https://acme.com/a.png" });
    await os.putBlob("credentials/acme/x.c2pa", new TextEncoder().encode("{}"), "application/json");
    expect(r2.objects.has("credentials/acme/x.c2pa")).toBe(true);
    expect(new TextDecoder().decode((await os.getBlob("credentials/acme/x.c2pa"))!)).toBe("{}");
  });

  it("shares semanto_connector_keys with the pipeline store: labels, the last signed request, revocation", async () => {
    const { store, os } = world();
    await store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full", current_version: null, custody: "hosted" });
    const k = await generateKeyPair();
    await store.putConnectorKey("acme", k.publicJwk, "wordpress", AT, "Shop");
    await os.recordConnectorRequest(k.publicJwk.kid, AT, "signature_failed");
    expect((await os.connectorByKid(k.publicJwk.kid))).toMatchObject({ label: "Shop", last_result: "signature_failed", last_ok_at: null });
    await os.recordConnectorRequest(k.publicJwk.kid, "2026-10-23T12:05:00.000Z", "ok");
    expect((await os.connectors("acme"))[0]).toMatchObject({ last_result: "ok", last_ok_at: "2026-10-23T12:05:00.000Z" });
    expect(await os.revokeConnector(k.publicJwk.kid, AT)).toBe(true);
    expect(await os.revokeConnector(k.publicJwk.kid, AT)).toBe(false);
    expect(await store.connectorKeys("acme")).toEqual([]);
  });

  it("a Google connection round-trips with its sealed token and marks needs_reconnect with one alert", async () => {
    const { os } = world();
    const sealed = await sealText("refresh-fixture", SEAL, "google-refresh", "acme");
    await os.putGoogle({ trooth_id: "acme", state: "connected", account_email: "o@acme.com", products: ["merchant"], scopes: ["openid"], sealed_refresh_token: sealed, merchant_accounts: [{ id: "1", name: "A" }], business_locations: [], connected_at: AT, connected_by: "u", last_refresh_at: null, last_error: null, alerted_at: null });
    const g = (await os.getGoogle("acme"))!;
    expect(await openText(g.sealed_refresh_token, SEAL, "google-refresh", "acme")).toBe("refresh-fixture");
    expect(await openText(g.sealed_refresh_token, SEAL, "google-refresh", "beta")).toBeNull();
    expect(await openText(g.sealed_refresh_token, SEAL, "another-context", "acme")).toBeNull();
    expect(await os.markGoogleNeedsReconnect("acme", "gone", AT)).toBe(true);
    expect(await os.markGoogleNeedsReconnect("acme", "gone", AT)).toBe(false);
    expect((await os.getGoogle("acme"))!.state).toBe("needs_reconnect");
    await os.deleteGoogle("acme");
    expect(await os.getGoogle("acme")).toBeNull();
  });
});

describe("a staged key in src/db/d1.ts", () => {
  it("is published, never the hosted signing key, and does not set the custody until it is settled", async () => {
    const { d1, r2, store, os } = world();
    await store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full", current_version: null, custody: "customer" });
    const keys = new D1Keys(d1.asD1(), r2.asR2(), null, SEAL);
    const old = await generateKeyPair();
    await store.putKey("acme", { public_jwk: { ...old.publicJwk, nbf: AT }, custody: "hosted", created_at: AT }, old.privateJwk);
    const next = await generateKeyPair();
    await store.putKey("acme", { public_jwk: { ...next.publicJwk, nbf: AT }, custody: "customer", created_at: "2026-10-23T12:01:00.000Z", next: true }, null);
    expect((await keys.getCompanyJwks("acme")).keys.map((k) => k.kid)).toEqual([old.publicJwk.kid, next.publicJwk.kid]);
    expect((await keys.getCompanySigningKey("acme"))!.kid).toBe(old.publicJwk.kid);
    expect((await store.getCompany("acme"))!.custody).toBe("hosted");
    expect((await store.keys("acme")).find((k) => k.public_jwk.kid === next.publicJwk.kid)!.next).toBe(true);
    await store.putKey("acme", { public_jwk: { ...next.publicJwk, nbf: AT }, custody: "customer", created_at: "2026-10-23T12:01:00.000Z" }, null);
    expect((await store.getCompany("acme"))!.custody).toBe("customer");
    await os.noteBindingCheck("acme", next.publicJwk.kid, true, AT);
    expect(await os.bindingCheck("acme", next.publicJwk.kid)).toEqual({ found: true, checked_at: AT });
  });
});

describe("D1CommerceStore.removeOffers", () => {
  it("deletes every offer for the sku and answers how many", async () => {
    const { d1 } = world();
    const commerce = new D1CommerceStore(d1.asD1());
    const offer = (id: string, sku: string) => ({ offer: { id, sku, as_of: AT, not_after: AT } as never, jws: "h.p.s", kid: "k" });
    await commerce.putOffer("acme", offer("smo_1", "ANV-100"));
    await commerce.putOffer("acme", offer("smo_2", "ANV-100"));
    await commerce.putOffer("acme", offer("smo_3", "ROC-200"));
    expect(await commerce.removeOffers("acme", "ANV-100")).toBe(2);
    expect((await commerce.offers("acme")).map((o) => o.offer.sku)).toEqual(["ROC-200"]);
    expect(await commerce.removeOffers("acme", "ANV-100")).toBe(0);
  });
});
