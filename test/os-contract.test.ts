// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The workspace contract of 23 October 2026 (docs/program/CONTRACT-2026-10-23.md,
// docs/spec/os-api.md) through the Hono app, with in-memory ports only
// (test/helpers/os-world.ts). One describe per contract section. Google,
// Resend, worker-f and DNS are fixtures; every figure is made up.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair } from "@/core/keys";
import { JWS_TYPES, signObject } from "@/core/jws";
import { canonicalize } from "@/core/canonical";
import { ROTATION_OVERLAP_MS } from "@/identity/keys";
import { BACKOFF_SECONDS, RetryLater, tokenHash } from "@/os/common";
import { checkEventSignature, recallEventId } from "@/os/recalls";
import { signRecall } from "@/commerce/recalls";
import { signProductRecord } from "@/commerce/product-record";
import { runQueue } from "@/serve/routes";
import { signPost, generateConnectorKey } from "../adapters/shared/sign-request.mjs";
import { API, EVENTS_SECRET, NOW, OS, SEAL, buildAndSign, drain, get, json, osWorld, post, pub, purposeAssertion, type OsWorld } from "./helpers/os-world";
import { BANNED_WORDS, ELLIPSIS } from "./helpers/house-rules";

const DAY_MS = 86_400_000;
const catalogBody = readFileSync(new URL("./fixtures/integration/fixture-catalog.json", import.meta.url), "utf8");

async function postCatalog(w: OsWorld, privateJwk: Parameters<typeof signPost>[0]["privateJwk"], body = catalogBody): Promise<Response> {
  const url = `${OS}/acme/commerce/catalog`;
  const headers = await signPost({ url, body, privateJwk, created: Math.floor(w.clock.now.getTime() / 1000) });
  return w.app.request(url, { method: "POST", headers, body });
}

// ------------------------------------------------------------------------ the audit trail and the rate group

describe("audit trail and os_write", () => {
  it("appends one audit row per write, with hashes and the request id, and shows the newest 20 as recent_changes", async () => {
    const w = await osWorld();
    for (let i = 0; i < 22; i++) await post(w, "/acme/settings", { content_signals: { "ai-train": i % 2 === 0, search: true, "ai-input": true } });
    const r = await get(w, "/acme/company");
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.recent_changes).toHaveLength(20);
    expect(body.recent_changes[0]).toMatchObject({ who: "Ada Owner", role: "owner", action: "settings.save", target: "delivery", at: NOW.toISOString() });
    expect(body.recent_changes[0].before_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.recent_changes[0].after_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.recent_changes[0].request_id).toMatch(/^[0-9a-f]{16}$/);
    expect(w.osStore.audit).toHaveLength(22);
  });

  it("limits workspace writes to 30 a minute per session subject (os_write), with Retry-After", async () => {
    const w = await osWorld();
    const answers: number[] = [];
    for (let i = 0; i < 31; i++) answers.push((await post(w, "/acme/settings/preview", {})).status);
    expect(answers.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(answers[30]).toBe(429);
    const limited = await post(w, "/acme/settings/preview", {});
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another person in the same workspace has their own bucket.
    expect((await post(w, "/acme/settings/preview", {}, "Bearer admin-token")).status).toBe(200);
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    expect((await post(w, "/acme/settings/preview", {})).status).toBe(200);
  });

  it("denies every new route without a session (401) and refuses writes to a viewer (403)", async () => {
    const w = await osWorld();
    for (const path of ["/acme/keys", "/acme/connectors", "/acme/google", "/acme/company", "/acme/writeback/runs", "/acme/sellers/lists", "/acme/credentials", "/acme/receipts"]) {
      expect([path, (await w.app.request(`${OS}${path}`)).status]).toEqual([path, 401]);
    }
    for (const path of ["/acme/settings/preview", "/acme/keys/rotation/start", "/acme/connectors/create", "/acme/google/connect", "/acme/company/alerts", "/acme/writeback/send", "/acme/sellers/lists"]) {
      expect([path, (await w.app.request(`${OS}${path}`, { method: "POST", body: "{}" })).status]).toEqual([path, 401]);
      expect([path, (await post(w, path, {}, "Bearer viewer-token")).status]).toEqual([path, 403]);
    }
  });
});

// ------------------------------------------------------------------------ 1a. delivery settings

describe("1a. delivery settings: preview and audited save", () => {
  it("previews the effects route by route without saving, and lists the issues", async () => {
    const w = await osWorld();
    const r = await post(w, "/acme/settings/preview", { formats: { markdown: true, jsonld: false, llms: true, sitemap_md: true, whole_file: true }, content_signals: { "ai-train": true, search: true, "ai-input": true } });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.object).toBe("semanto.settings_preview");
    expect(body.issues).toEqual([]);
    expect(body.effects).toContainEqual({ route: "/public/semanto/acme/facts.jsonld", before: "served (JSON-LD)", after: "404 representation_not_offered (turned off)" });
    expect(body.effects).toContainEqual({ route: "/public/semanto/acme/* Content-Signal header", before: "ai-train=no, search=yes, ai-input=yes", after: "ai-train=yes, search=yes, ai-input=yes" });
    // Nothing was saved and nothing was audited.
    const view = await json(await get(w, "/acme/settings"));
    expect(view).toMatchObject({ object: "semanto.settings", trooth_id: "acme", domain: "acme.com", detection: null, updated_at: null });
    expect(view.settings.formats.jsonld).toBe(true);
    expect(w.osStore.audit).toHaveLength(0);
    const bad = await json(await post(w, "/acme/settings/preview", { host: "nginx" }));
    expect(bad.issues.map((i: { path: string }) => i.path)).toEqual(["where.own_domain"]);
    expect(bad.effects).toEqual([]);
  });

  it("saves with an audit row, answers 422 with the issues, and refuses a member", async () => {
    const w = await osWorld();
    const refused = await post(w, "/acme/settings", { host: "nginx" });
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({ code: "settings_invalid", issues: [{ path: "where.own_domain" }] });
    expect((await post(w, "/acme/settings", {}, "Bearer member-token")).status).toBe(403);
    const ok = await post(w, "/acme/settings", { when_page_changed: "prompt_to_sign" });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ object: "semanto.settings", settings: { when_page_changed: "prompt_to_sign" }, updated_at: NOW.toISOString() });
    expect(w.osStore.audit.map((a) => a.action)).toEqual(["settings.save"]);
  });
});

// ------------------------------------------------------------------------ 1b. keys

describe("1b. signing keys: states, staged rotation, binding, revoke", () => {
  it("answers each key's state, created_at and overlap_until, the binding and no rotation", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const body = await json(await get(w, "/acme/keys"));
    expect(body.object).toBe("semanto.keys");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ custody: "hosted", state: "active", overlap_until: null, created_at: NOW.toISOString() });
    expect(body.binding).toEqual({ dns_name: "_trooth-keys.acme.com", dns_value: `v=trooth1; kid=${body.keys[0].kid}`, found: false, checked_at: null });
    expect(body.rotation).toBeNull();
  });

  it("stages a hosted rotation: next is published at once but does not sign until confirmed with a passkey", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const oldKid = (await json(await get(w, "/acme/keys"))).keys[0].kid as string;
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "hosted" }));
    expect(started).toMatchObject({ object: "semanto.key_rotation", state: "started", current_kid: oldKid, custody: "hosted" });
    expect(started.dns_record).toEqual({ name: "_trooth-keys.acme.com", value: `v=trooth1; kid=${started.next_kid}` });
    // Published in the JWK Set now, so verifiers learn it.
    const jwks = await json(await pub(w, "/acme/keys.json"));
    expect(jwks.keys.map((k: { kid: string }) => k.kid)).toEqual(expect.arrayContaining([oldKid, started.next_kid]));
    // Not used to sign: responses are still signed with the old key, and the hosted signing key is the old one.
    expect((await w.pipeline.d.keys.getCompanySigningKey("acme"))!.kid).toBe(oldKid);
    const view = await json(await get(w, "/acme/keys"));
    expect(view.keys.find((k: { kid: string }) => k.kid === started.next_kid).state).toBe("next");
    expect(view.rotation).toMatchObject({ rotation_id: started.rotation_id, state: "started", next_kid: started.next_kid, current_kid: oldKid, overlap_until: null });
    // A second start is refused while one is open, and so is the one-call rotate.
    expect((await post(w, "/acme/keys/rotation/start", { custody: "hosted" })).status).toBe(409);
    expect((await post(w, "/acme/keys/rotate", {})).status).toBe(409);
    // Confirm without the passkey step: nothing changes.
    const noPasskey = await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id });
    expect((await json(noPasskey)).code).toBe("passkey_cancelled");
    // An assertion for another request does not count.
    const otherAssertion = await purposeAssertion(w, { purpose: "key_rotation", rotation_id: "rot_another" });
    expect((await json(await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id, assertion: otherAssertion }))).code).toBe("passkey_invalid");
    const assertion = await purposeAssertion(w, { purpose: "key_rotation", rotation_id: started.rotation_id });
    const confirmed = await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id, assertion });
    expect(confirmed.status).toBe(200);
    const c = await json(confirmed);
    expect(c).toMatchObject({ state: "confirmed", active_kid: started.next_kid, retiring_kids: [oldKid], overlap_until: new Date(NOW.getTime() + ROTATION_OVERLAP_MS).toISOString() });
    expect((await w.pipeline.d.keys.getCompanySigningKey("acme"))!.kid).toBe(started.next_kid);
    const after = await json(await get(w, "/acme/keys"));
    expect(after.keys.find((k: { kid: string }) => k.kid === oldKid)).toMatchObject({ state: "retiring", overlap_until: c.overlap_until });
    expect(after.keys.find((k: { kid: string }) => k.kid === started.next_kid).state).toBe("active");
    expect(after.rotation.state).toBe("confirmed");
    // Cancel after confirm is refused.
    expect((await post(w, "/acme/keys/rotation/cancel", { rotation_id: started.rotation_id })).status).toBe(409);
    // The overlap ends with no cron: read after 30 days, the old key is expired and the rotation completed.
    w.clock.now = new Date(NOW.getTime() + ROTATION_OVERLAP_MS + 1000);
    const later = await json(await get(w, "/acme/keys"));
    expect(later.keys.find((k: { kid: string }) => k.kid === oldKid).state).toBe("expired");
    expect(later.rotation.state).toBe("completed");
    expect(w.osStore.audit.map((a) => a.action).filter((a) => a.startsWith("keys."))).toEqual(["keys.rotation.start", "keys.rotation.confirm"]);
  });

  it("keys/rotation/options and sellers/lists/options answer the sign-options shape bound to what they approve", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "hosted" }));
    expect(started.overlap_until).toBe(new Date(NOW.getTime() + ROTATION_OVERLAP_MS).toISOString());
    expect((await post(w, "/acme/keys/rotation/options", { rotation_id: "rot_unknown" })).status).toBe(409);
    const opts = await json(await post(w, "/acme/keys/rotation/options", { rotation_id: started.rotation_id }));
    expect(opts).toMatchObject({ object: "semanto.sign_options", purpose: "key_rotation", binding: `rotation:${started.rotation_id}` });
    expect(opts.publicKey.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const auth = await w.wallet.for("Bearer owner-token");
    const confirmed = await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id, assertion: await auth.assert(opts.publicKey) });
    expect(confirmed.status).toBe(200);
    const draft = { trooth_id: "acme", version: 1, issued_at: NOW.toISOString(), sellers: [{ seller_id: "s-1", name: "Fixture Outlet", domain: "outlet.example", authorized_from: "2026-01-01T00:00:00.000Z" }] };
    expect((await post(w, "/acme/sellers/lists/options", { draft: { ...draft, version: 0 } })).status).toBe(400);
    const sopts = await json(await post(w, "/acme/sellers/lists/options", { draft }));
    expect(sopts).toMatchObject({ object: "semanto.sign_options", purpose: "seller_list" });
    expect((await post(w, "/acme/sellers/lists", { draft, assertion: await auth.assert(sopts.publicKey) })).status).toBe(201);
    const customer = await osWorld({ custody: "customer" });
    expect((await post(customer, "/acme/sellers/lists/options", { draft })).status).toBe(409);
  });

  it("cancels a started rotation: the next key is revoked and on the revocation list at once", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "hosted" }));
    const cancelled = await json(await post(w, "/acme/keys/rotation/cancel", { rotation_id: started.rotation_id }));
    expect(cancelled).toMatchObject({ state: "cancelled", revoked_kid: started.next_kid });
    const list = await json(await pub(w, "/acme/revocations"));
    expect(list.list.revocations.map((e: { ref: string }) => e.ref)).toContain(started.next_kid);
    const view = await json(await get(w, "/acme/keys"));
    expect(view.keys.find((k: { kid: string }) => k.kid === started.next_kid).state).toBe("revoked");
    expect(view.rotation.state).toBe("cancelled");
    expect((await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id })).status).toBe(409);
  });

  it("customer custody: starts with the browser's public JWK and refuses a private one; no passkey between customer keys", async () => {
    const w = await osWorld({ custody: "customer" });
    const first = await generateKeyPair();
    await post(w, "/acme/keys/rotate", { public_jwk: first.publicJwk });
    expect((await json(await post(w, "/acme/keys/rotation/start", { custody: "customer", public_jwk: first.privateJwk }))).detail).toContain("private key");
    expect((await post(w, "/acme/keys/rotation/start", { custody: "customer" })).status).toBe(400);
    const next = await generateKeyPair();
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "customer", public_jwk: next.publicJwk }));
    expect(started).toMatchObject({ state: "started", next_kid: next.publicJwk.kid, current_kid: first.publicJwk.kid });
    const confirmed = await json(await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id }));
    expect(confirmed).toMatchObject({ state: "confirmed", active_kid: next.publicJwk.kid, retiring_kids: [first.publicJwk.kid] });
  });

  it("revokes only with the typed kid, refuses the only active key, and lists a revoked retiring key", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const kid = (await json(await get(w, "/acme/keys"))).keys[0].kid as string;
    expect((await json(await post(w, `/acme/keys/${kid}/revoke`, {}))).detail).toContain(`"confirm": "${kid}"`);
    const only = await post(w, `/acme/keys/${kid}/revoke`, { confirm: kid });
    expect(only.status).toBe(409);
    expect((await json(only)).detail).toContain("only active signing key");
    const started = await json(await post(w, "/acme/keys/rotation/start", { custody: "hosted" }));
    expect((await json(await post(w, `/acme/keys/${started.next_kid}/revoke`, { confirm: started.next_kid }))).detail).toContain("Cancel the rotation");
    await post(w, "/acme/keys/rotation/confirm", { rotation_id: started.rotation_id, assertion: await purposeAssertion(w, { purpose: "key_rotation", rotation_id: started.rotation_id }) });
    const revoked = await post(w, `/acme/keys/${kid}/revoke`, { confirm: kid, reason: "Rotated out early." });
    expect(revoked.status).toBe(200);
    expect((await json(await pub(w, "/acme/revocations"))).list.revocations.map((e: { ref: string }) => e.ref)).toContain(kid);
    expect(w.osStore.audit.at(-1)).toMatchObject({ action: "keys.revoke", target: kid });
  });

  it("checks the DNS binding now and remembers the answer", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const kid = (await json(await get(w, "/acme/keys"))).keys[0].kid as string;
    const missing = await json(await post(w, "/acme/keys/binding/check", {}));
    expect(missing).toMatchObject({ dns_name: "_trooth-keys.acme.com", found: false, checked_at: NOW.toISOString() });
    w.dns["_trooth-keys.acme.com"] = [`v=trooth1; kid=${kid}`];
    const found = await json(await post(w, "/acme/keys/binding/check", {}, "Bearer member-token"));
    expect(found).toEqual({ dns_name: "_trooth-keys.acme.com", dns_value: `v=trooth1; kid=${kid}`, found: true, checked_at: NOW.toISOString() });
    expect((await json(await get(w, "/acme/keys"))).binding.found).toBe(true);
  });
});

// ------------------------------------------------------------------------ 1c. read receipts

describe("1c. read receipts: filters, cursor, CSV", () => {
  async function seeded(): Promise<OsWorld> {
    const w = await osWorld();
    await buildAndSign(w);
    const file = (await w.versions.getCurrent("acme"))!;
    const about = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const pricing = file.header.pages_manifest.find((p) => p.url === "https://acme.com/pricing")!;
    const row = (i: number, over: Partial<Parameters<typeof w.receipts.put>[0]>) => ({ id: `smd_fixture${i}`, trooth_id: "acme", version: 1, page_id: about.id, representation: "markdown", agent_key_url: null, keyid: null, proof: "none" as const, read_at: "2026-10-22T09:00:00.000Z", ip_hash: "", count: 1, ...over });
    await w.receipts.put(row(1, { agent_key_url: "https://agent.fixtureagent.com/.well-known/http-message-signatures-directory", keyid: "k1", proof: "web_bot_auth", count: 3 }));
    await w.receipts.put(row(2, { read_at: "2026-10-22T10:30:00.000Z", agent_key_url: "https://agent.fixtureagent.com/.well-known/http-message-signatures-directory", keyid: "k1", proof: "web_bot_auth" }));
    await w.receipts.put(row(3, { page_id: pricing.id, count: 2 }));
    await w.receipts.put(row(4, { page_id: null, read_at: "2026-10-21T08:00:00.000Z" }));
    await w.receipts.put(row(5, { read_at: "2026-06-01T08:00:00.000Z" }));
    return w;
  }

  it("groups by day, agent and path, names an agent only behind a proven key, and filters", async () => {
    const w = await seeded();
    const all = await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23"));
    expect(all.object).toBe("semanto.receipts");
    expect(all.rows[0]).toEqual({ day: "2026-10-22", agent: "agent.fixtureagent.com", operator: "agent.fixtureagent.com", path: "/about", reads: 4, signed: true, last_at: "2026-10-22T10:30:00.000Z" });
    expect(all.rows).toContainEqual({ day: "2026-10-21", agent: "unproven reader", operator: null, path: "(whole file)", reads: 1, signed: false, last_at: "2026-10-21T08:00:00.000Z" });
    // QA-08: agents counts the readers proven by a signature only; the unproven reader is not an agent.
    expect(all.totals).toEqual({ reads: 7, agents: 1, paths: 3 });
    expect(all.agents).toEqual(["agent.fixtureagent.com", "unproven reader"]);
    expect(all.next_cursor).toBeNull();
    expect((await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23&status=signed_agent"))).totals.reads).toBe(4);
    expect((await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23&status=unsigned"))).totals.reads).toBe(3);
    expect((await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23&path=/pri"))).rows.map((r: { path: string }) => r.path)).toEqual(["/pricing"]);
    expect((await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23&agent=agent.fixtureagent.com"))).totals.reads).toBe(4);
  });

  it("pages with an opaque cursor and refuses a range over 92 days and a bad limit", async () => {
    const w = await seeded();
    const first = await json(await get(w, "/acme/receipts?from=2026-10-20&to=2026-10-23&limit=2"));
    expect(first.rows).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await json(await get(w, `/acme/receipts?from=2026-10-20&to=2026-10-23&limit=2&cursor=${first.next_cursor}`));
    expect(second.rows).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect((await get(w, "/acme/receipts?from=2026-06-01&to=2026-10-23")).status).toBe(400);
    expect((await get(w, "/acme/receipts?limit=500")).status).toBe(400);
    expect((await get(w, "/acme/receipts?cursor=not-ours")).status).toBe(400);
    expect((await get(w, "/acme/receipts?status=bots")).status).toBe(400);
  });

  it("streams the same rows as CSV with the fixed header and the injection guard", async () => {
    const w = await seeded();
    await w.receipts.put({ id: "smd_evil", trooth_id: "acme", version: 9, page_id: "=HYPERLINK(\"https://evil.example\")", representation: "markdown", agent_key_url: null, keyid: null, proof: "none", read_at: "2026-10-22T11:00:00.000Z", ip_hash: "", count: 1 });
    const r = await get(w, "/acme/receipts.csv?from=2026-10-20&to=2026-10-23");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    const lines = (await r.text()).split("\r\n");
    expect(lines[0]).toBe("day,agent,operator,path,reads,signed,last_at");
    expect(lines[1]).toBe("2026-10-22,agent.fixtureagent.com,agent.fixtureagent.com,/about,4,true,2026-10-22T10:30:00.000Z");
    expect(lines.find((l) => l.includes("HYPERLINK"))).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
  });
});

// ------------------------------------------------------------------------ 1d. connector keys and the connect flow

describe("1d. connector keys", () => {
  it("names the exact problem with a pasted key, takes a label, and refuses a duplicate kid", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    const detail = async (public_jwk: unknown) => (await json(await post(w, "/acme/connectors", { public_jwk }))).detail;
    expect(await detail(undefined)).toBe("Send the connector's public key as public_jwk.");
    expect(await detail("{not json")).toBe("The key is not JSON. Paste the public key exactly as the connector printed it: a JSON object that starts with {.");
    expect(await detail(k.privateJwk)).toBe('This key has private parts (the "d" member). Paste only the public key and keep the private key on the connector\'s server.');
    expect(await detail({ kty: "EC", crv: "P-256", x: "abc", y: "def" })).toBe("This is not an Ed25519 key (kty must be OKP and crv Ed25519). Make an Ed25519 key in the connector and paste its public key.");
    const added = await post(w, "/acme/connectors", { public_jwk: JSON.stringify(k.publicJwk), label: "Shop plugin", source: "api" });
    expect(added.status).toBe(200);
    expect(await json(added)).toMatchObject({ object: "semanto.connector_key", kid: k.publicJwk.kid, source: "api", label: "Shop plugin" });
    const dup = await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    expect(dup.status).toBe(409);
    expect((await json(dup)).detail).toBe(`This key is already on file (kid ${k.publicJwk.kid}). Each connector needs its own key.`);
    const list = await json(await get(w, "/acme/connectors"));
    expect(list).toEqual({ object: "semanto.connectors", trooth_id: "acme", keys: [{ kid: k.publicJwk.kid, source: "api", label: "Shop plugin", created_at: NOW.toISOString(), last_used_at: null, revoked_at: null }] });
  });

  it("creates a pair, answers the private JWK once, keeps only the public key, and the key signs catalogs", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    expect((await post(w, "/acme/connectors/create", { source: "wordpress" })).status).toBe(400);
    const r = await post(w, "/acme/connectors/create", { source: "app", label: "Created here" });
    expect(r.status).toBe(201);
    const created = await json(r);
    expect(created.secret_shown_once).toBe(true);
    expect(created.private_jwk.d).toBeTruthy();
    expect(created.public_jwk.d).toBeUndefined();
    expect(JSON.stringify(w.store.connectors.get("acme"))).not.toContain(created.private_jwk.d);
    expect(JSON.stringify(w.osStore.audit)).not.toContain(created.private_jwk.d);
    expect(JSON.stringify(await json(await get(w, "/acme/connectors")))).not.toContain(created.private_jwk.d);
    expect((await postCatalog(w, created.private_jwk)).status).toBe(202);
  });

  it("tests a connector from its last signed request: never_seen, connected, signature_failed, revoked", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk, source: "api" });
    const test = async () => json(await post(w, `/acme/connectors/${k.publicJwk.kid}/test`, {}));
    expect(await test()).toMatchObject({ object: "semanto.connector_test", kid: k.publicJwk.kid, verdict: "never_seen", last_signed_request_at: null, last_result: null });
    expect((await postCatalog(w, k.privateJwk)).status).toBe(202);
    expect(await test()).toMatchObject({ verdict: "connected", last_signed_request_at: NOW.toISOString(), last_result: "ok" });
    expect((await json(await get(w, "/acme/connectors"))).keys[0].last_used_at).toBe(NOW.toISOString());
    // A request that names this kid with a signature that does not check out.
    const url = `${OS}/acme/commerce/catalog`;
    const headers = await signPost({ url, body: catalogBody, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    expect((await w.app.request(url, { method: "POST", headers, body: catalogBody.replace("49.00", "1.00") })).status).toBe(401);
    expect(await test()).toMatchObject({ verdict: "signature_failed", last_result: "signature_failed" });
    expect((await json(await post(w, `/acme/connectors/${k.publicJwk.kid}/revoke`, {}))).detail).toContain("confirm");
    expect((await post(w, `/acme/connectors/${k.publicJwk.kid}/revoke`, { confirm: k.publicJwk.kid })).status).toBe(200);
    expect(await test()).toMatchObject({ verdict: "revoked" });
    // A revoked key no longer signs catalogs.
    expect((await postCatalog(w, k.privateJwk)).status).toBe(401);
  });

  it("a product sent as discontinued is taken out of the offers (a connector has no delete call)", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    expect((await postCatalog(w, k.privateJwk)).status).toBe(202);
    expect((await w.commerce.offers("acme")).map((o) => o.offer.sku)).toEqual(["ANV-100"]);
    const doc = JSON.parse(catalogBody);
    const gone = JSON.stringify({ ...doc, products: [{ id: "501", sku: "ANV-100", stock_status: "discontinued" }] });
    const r = await postCatalog(w, k.privateJwk, gone);
    expect(r.status).toBe(202);
    expect(await json(r)).toMatchObject({ removed: ["ANV-100"], offers: [] });
    expect(await w.commerce.offers("acme")).toEqual([]);
    expect((await json(await pub(w, "/acme/offers"))).offers ?? []).toEqual([]);
  });

  it("an edge adapter answers its kid at /.well-known/trooth-semanto-connector, read through the SSRF-guarded probe", async () => {
    const w = await osWorld();
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk, source: "edge" });
    const url = "https://acme.com/.well-known/trooth-semanto-connector";
    expect(await json(await post(w, `/acme/connectors/${k.publicJwk.kid}/test`, {}))).toMatchObject({ verdict: "never_seen", checked_url: url, adapter_kid: null });
    w.probes[url] = { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ kid: k.publicJwk.kid })) };
    // Review finding: the unsigned well-known GET is not a signed request, so it never fills last_signed_request_at or last_result.
    expect(await json(await post(w, `/acme/connectors/${k.publicJwk.kid}/test`, {}))).toMatchObject({ verdict: "connected", adapter_kid: k.publicJwk.kid, last_result: null, last_signed_request_at: null });
    expect((await json(await get(w, "/acme/connectors"))).keys[0]).toMatchObject({ kid: k.publicJwk.kid, last_used_at: null });
  });
});

describe("1d. the public connect flow for app installs (Shopify)", () => {
  const open = async (w: OsWorld, over: Record<string, unknown> = {}) => {
    const k = await generateConnectorKey();
    const r = await pub(w, "/connect/sessions", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ app: "shopify", account: "acme-store.myshopify.com", public_jwk: k.publicJwk, return_url: "https://admin.shopify.com/store/acme-store/apps/trooth", ...over }) });
    return { k, r, body: await json(r) };
  };
  const poll = (w: OsWorld, id: string, token: string) => pub(w, `/connect/sessions/${id}`, { headers: { authorization: `Bearer ${token}` } });

  it("opens a session, polls pending, shows the approve page, approves, and registers the key as shopify:<shop>", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const { k, r, body } = await open(w);
    expect(r.status).toBe(201);
    expect(body.approve_url).toBe(`https://trooth.co/dashboard/semanto/connect/${body.session_id}`);
    expect(body.expires_at).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());
    expect(w.osStore.sessions.get(body.session_id)!.poll_token_hash).toBe(await tokenHash(body.poll_token));
    expect(JSON.stringify([...w.osStore.sessions.values()])).not.toContain(body.poll_token);
    expect((await json(await poll(w, body.session_id, body.poll_token))).state).toBe("pending");
    expect((await poll(w, body.session_id, "wrong")).status).toBe(401);
    const page = await json(await w.app.request(`${OS}/connect/${body.session_id}`, { headers: { authorization: "Bearer owner-token" } }));
    expect(page).toMatchObject({ object: "semanto.connect_request", app: "shopify", account: "acme-store.myshopify.com", state: "pending", companies: [{ trooth_id: "acme", domain: "acme.com", org: "Acme Inc" }] });
    expect((await w.app.request(`${OS}/connect/${body.session_id}`)).status).toBe(401);
    const approved = await json(await post(w, `/acme/connect/${body.session_id}/approve`, {}));
    expect(approved).toMatchObject({ state: "approved", kid: k.publicJwk.kid, source: "shopify:acme-store.myshopify.com", return_url: "https://admin.shopify.com/store/acme-store/apps/trooth" });
    expect(await json(await poll(w, body.session_id, body.poll_token))).toMatchObject({ state: "approved", trooth_id: "acme", kid: k.publicJwk.kid });
    expect((await json(await get(w, "/acme/connectors"))).keys[0]).toMatchObject({ kid: k.publicJwk.kid, source: "shopify:acme-store.myshopify.com", label: "Shopify: acme-store.myshopify.com" });
    expect((await post(w, `/acme/connect/${body.session_id}/deny`, {})).status).toBe(409);
    // The app posts its catalog signed with its key.
    expect((await postCatalog(w, k.privateJwk)).status).toBe(202);
  });

  it("the app's Disconnect revokes with reason disconnected, recorded in the audit row", async () => {
    const w = await osWorld();
    const { k, body } = await open(w);
    await post(w, `/acme/connect/${body.session_id}/approve`, {});
    const url = `${API}/connect/uninstall`;
    const payload = JSON.stringify({ app: "shopify", account: "acme-store.myshopify.com", kid: k.publicJwk.kid, reason: "disconnected" });
    const r = await w.app.request(url, { method: "POST", headers: await signPost({ url, body: payload, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) }), body: payload });
    expect(await json(r)).toMatchObject({ kid: k.publicJwk.kid, reason: "disconnected" });
    expect(w.osStore.audit.at(-1)).toMatchObject({ action: "connectors.uninstall.disconnected", target: k.publicJwk.kid });
  });

  it("validates the request, expires after 15 minutes, and a denied session never registers a key", async () => {
    const w = await osWorld();
    expect((await open(w, { app: "bigcommerce" })).r.status).toBe(400);
    expect((await open(w, { account: "acme.com" })).r.status).toBe(400);
    expect((await open(w, { return_url: "http://insecure.example" })).r.status).toBe(400);
    expect((await open(w, { return_url: "https://evil.example/back" })).r.status).toBe(400);
    expect((await open(w, { return_url: "https://other-store.myshopify.com/admin/apps/semanto-by-trooth" })).r.status).toBe(400);
    expect((await open(w, { return_url: "https://acme-store.myshopify.com/admin/apps/semanto-by-trooth" })).r.status).toBe(201);
    const denied = await open(w);
    expect((await json(await post(w, `/acme/connect/${denied.body.session_id}/deny`, {}))).state).toBe("denied");
    expect((await json(await poll(w, denied.body.session_id, denied.body.poll_token))).state).toBe("denied");
    expect((await json(await get(w, "/acme/connectors"))).keys).toEqual([]);
    const late = await open(w);
    w.clock.now = new Date(NOW.getTime() + 15 * 60_000 + 1);
    expect((await json(await poll(w, late.body.session_id, late.body.poll_token))).state).toBe("expired");
    expect((await post(w, `/acme/connect/${late.body.session_id}/approve`, {})).status).toBe(410);
    expect((await w.app.request(`${OS}/connect/${late.body.session_id}`, { headers: { authorization: "Bearer owner-token" } })).status).toBe(410);
    expect((await w.app.request(`${OS}/connect/cs_unknown`, { headers: { authorization: "Bearer owner-token" } })).status).toBe(404);
  });

  it("limits opening sessions to 10 a minute per address, polls to 40 a minute per session, and uninstalls to 10 a minute per key", async () => {
    const w = await osWorld();
    const answers: number[] = [];
    const opened = [];
    for (let i = 0; i < 11; i++) {
      const o = await open(w);
      answers.push(o.r.status);
      if (o.r.status === 201) opened.push(o);
    }
    expect(answers.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(answers[10]).toBe(429);
    // Polls from the same shared egress address are not counted per address: each session has its own 40 a minute.
    const first = opened[0]!.body;
    const polls: number[] = [];
    for (let i = 0; i < 41; i++) polls.push((await pub(w, `/connect/sessions/${first.session_id}`, { headers: { authorization: `Bearer ${first.poll_token}`, "cf-connecting-ip": "203.0.113.9" } })).status);
    expect(polls.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(polls[40]).toBe(429);
    const second = opened[1]!.body;
    expect((await pub(w, `/connect/sessions/${second.session_id}`, { headers: { authorization: `Bearer ${second.poll_token}`, "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
    // Uninstalls are counted per key id.
    const stranger = await generateConnectorKey();
    const url = `${API}/connect/uninstall`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const headers = await signPost({ url, body: "{}", privateJwk: stranger.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
      statuses.push((await w.app.request(url, { method: "POST", headers: { ...headers, "cf-connecting-ip": "203.0.113.9" }, body: "{}" })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("QA-16: an uninstall before approval withdraws the waiting request, so Approve cannot register a key no app holds", async () => {
    const w = await osWorld();
    // Opened half a second into a second, and withdrawn in that same second (created is whole seconds).
    w.clock.now = new Date(NOW.getTime() + 500);
    const { k, body } = await open(w);
    const url = `${API}/connect/uninstall`;
    const payload = JSON.stringify({ account: "acme-store.myshopify.com", reason: "uninstalled" });
    // Signed by another key naming this kid: nothing is withdrawn.
    const stranger = await generateConnectorKey();
    const forged = await signPost({ url, body: payload, privateJwk: { ...stranger.privateJwk, kid: k.publicJwk.kid }, created: Math.floor(NOW.getTime() / 1000) });
    expect((await w.app.request(url, { method: "POST", headers: forged, body: payload })).status).toBe(404);
    expect((await w.osStore.getConnectSession(body.session_id))?.state).toBe("pending");
    const headers = await signPost({ url, body: payload, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    const r = await w.app.request(url, { method: "POST", headers, body: payload });
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe("not_registered");
    expect((await w.osStore.getConnectSession(body.session_id))?.state).toBe("withdrawn");
    // Withdrawn, not denied: the poll, the approve page and both decisions say so.
    expect((await json(await pub(w, `/connect/sessions/${body.session_id}`, { headers: { authorization: `Bearer ${body.poll_token}` } }))).state).toBe("withdrawn");
    const page = await json(await get(w, `/connect/${body.session_id}`));
    expect(page).toMatchObject({ state: "withdrawn", return_url: "https://admin.shopify.com/store/acme-store/apps/trooth" });
    for (const d of ["approve", "deny"]) {
      const r2 = await post(w, `/acme/connect/${body.session_id}/${d}`, {});
      expect(r2.status).toBe(409);
      const p2 = await json(r2);
      expect(p2.code).toBe("connect_session_withdrawn");
      expect(p2.detail).toMatch(/^The store withdrew this request/);
    }
    expect((await json(await get(w, "/acme/connectors"))).keys.some((x: { kid: string }) => x.kid === k.publicJwk.kid)).toBe(false);
  });

  it("uninstall: the app's signed request revokes its own key, once, and a replay or a stranger is refused", async () => {
    const w = await osWorld();
    const { k, body } = await open(w);
    await post(w, `/acme/connect/${body.session_id}/approve`, {});
    const url = `${API}/connect/uninstall`;
    const payload = JSON.stringify({ account: "acme-store.myshopify.com" });
    const headers = await signPost({ url, body: payload, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    const stranger = await generateConnectorKey();
    const h2 = await signPost({ url, body: payload, privateJwk: stranger.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    // A well-formed signature by a key never registered is 404 not_registered, apart from a bad signature on a known key (401).
    const unknown = await w.app.request(url, { method: "POST", headers: h2, body: payload });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).code).toBe("not_registered");
    const badSig = await signPost({ url, body: payload, privateJwk: { ...stranger.privateJwk, kid: k.publicJwk.kid }, created: Math.floor(NOW.getTime() / 1000) });
    expect((await w.app.request(url, { method: "POST", headers: badSig, body: payload })).status).toBe(401);
    const badReason = JSON.stringify({ account: "acme-store.myshopify.com", reason: "bored" });
    expect((await w.app.request(url, { method: "POST", headers: await signPost({ url, body: badReason, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) }), body: badReason })).status).toBe(400);
    const r = await w.app.request(url, { method: "POST", headers, body: payload });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ object: "semanto.connector_revoked", trooth_id: "acme", kid: k.publicJwk.kid, reason: "uninstalled" });
    expect((await json(await get(w, "/acme/connectors"))).keys[0].revoked_at).toBe(NOW.toISOString());
    expect(w.osStore.audit.at(-1)).toMatchObject({ actor: `connector:${k.publicJwk.kid}`, who: `connector:${k.publicJwk.kid}`, role: "connector", action: "connectors.uninstall.uninstalled" });
    // The same request again is a replay (its nonce was used); a fresh request answers the same revocation.
    expect((await w.app.request(url, { method: "POST", headers, body: payload })).status).toBe(401);
    const h3 = await signPost({ url, body: payload, privateJwk: k.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    expect(await json(await w.app.request(url, { method: "POST", headers: h3, body: payload }))).toMatchObject({ kid: k.publicJwk.kid, revoked_at: NOW.toISOString() });
  });
});

// ------------------------------------------------------------------------ 1e. Connect Google

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const CONTENT = "https://www.googleapis.com/auth/content";
const BUSINESS = "https://www.googleapis.com/auth/business.manage";

/** A fixture Google that grants what it is asked, with one Merchant Center account and one location. */
function googleGrants(w: OsWorld, scope = `${CONTENT} ${BUSINESS} openid https://www.googleapis.com/auth/userinfo.email`): void {
  w.google.on("https://oauth2.googleapis.com/token", (_u, init) => {
    const p = new URLSearchParams(init.body);
    if (p.get("grant_type") === "authorization_code") return { status: 200, body: JSON.stringify({ access_token: "fixture-access-1", refresh_token: "fixture-refresh-token", expires_in: 3599, scope, token_type: "Bearer", id_token: `${b64url("{}")}.${b64url(JSON.stringify({ email: "owner@acme.com" }))}.sig` }) };
    return { status: 200, body: JSON.stringify({ access_token: "fixture-access-2", expires_in: 3599, token_type: "Bearer" }) };
  });
  w.google.on("https://merchantapi.googleapis.com/accounts/v1/accounts", () => ({ status: 200, body: JSON.stringify({ accounts: [{ name: "accounts/123456", accountId: "123456", accountName: "Acme Store" }] }) }));
  w.google.on("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", () => ({ status: 200, body: JSON.stringify({ accounts: [{ name: "accounts/777" }] }) }));
  w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/accounts/777/locations", () => ({ status: 200, body: JSON.stringify({ locations: [{ name: "locations/987", title: "Acme Inc" }] }) }));
}

async function connectGoogle(w: OsWorld): Promise<URL> {
  googleGrants(w);
  const start = await json(await post(w, "/acme/google/connect", { products: ["merchant", "business"] }));
  const url = new URL(start.authorization_url);
  const back = await pub(w, `/google/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=fixture-code`);
  expect(back.status).toBe(302);
  return new URL(back.headers.get("location")!);
}

describe("1e. Connect Google", () => {
  it("answers an authorization URL with PKCE S256, offline access, consent, incremental scopes and a state kept hashed", async () => {
    const w = await osWorld();
    const r = await post(w, "/acme/google/connect", { products: ["merchant"] });
    expect(r.status).toBe(200);
    const url = new URL((await json(r)).authorization_url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "fixture-client.apps.googleusercontent.com", redirect_uri: "https://api.trooth.co/public/semanto/google/callback", response_type: "code", scope: `${CONTENT} openid email`, access_type: "offline", prompt: "consent", include_granted_scopes: "true", code_challenge_method: "S256" });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = url.searchParams.get("state")!;
    const stored = [...w.osStore.googleStates.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state_hash).toBe(await tokenHash(state));
    expect(stored[0]!.expires_at).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect((await post(w, "/acme/google/connect", { products: ["ads"] })).status).toBe(400);
    expect((await post(w, "/acme/google/connect", { products: ["merchant"] }, "Bearer member-token")).status).toBe(403);
    expect((await (await osWorld({ google: false })).app.request(`${OS}/acme/google/connect`, { method: "POST", headers: { authorization: "Bearer owner-token" }, body: JSON.stringify({ products: ["merchant"] }) })).status).toBe(409);
  });

  it("the callback checks the state once, exchanges with the verifier, seals the refresh token and redirects to the dashboard", async () => {
    const w = await osWorld();
    const loc = await connectGoogle(w);
    expect(loc.toString()).toBe("https://trooth.co/dashboard/semanto/connections?google=connected");
    const exchange = w.google.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const form = new URLSearchParams(exchange.init.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const conn = w.osStore.google.get("acme")!;
    expect(conn.sealed_refresh_token).not.toContain("fixture-refresh-token");
    expect(JSON.stringify(w.osStore.audit)).not.toContain("fixture-refresh-token");
    const view = await json(await get(w, "/acme/google"));
    expect(view).toMatchObject({ object: "semanto.google", state: "connected", account_email: "owner@acme.com", merchant_accounts: [{ id: "123456", name: "Acme Store" }], business_locations: [{ name: "locations/987", title: "Acme Inc" }], connected_at: NOW.toISOString(), last_error: null });
    expect(view.scopes).toEqual([
      { scope: CONTENT, purpose: expect.any(String), granted: true },
      { scope: BUSINESS, purpose: expect.any(String), granted: true },
      { scope: "openid", purpose: expect.any(String), granted: true },
      { scope: "email", purpose: expect.any(String), granted: true },
    ]);
    expect(JSON.stringify(view)).not.toContain("fixture-refresh-token");
    // The state is single use.
    const again = await pub(w, `/google/callback?state=whatever&code=fixture-code`);
    expect(again.headers.get("location")).toBe("https://trooth.co/dashboard/semanto/connections?google=error&reason=state_invalid");
    expect((await pub(w, "/google/callback?error=access_denied&state=x")).headers.get("location")).toContain("reason=access_denied");
  });

  it("an expired state and declined scopes come back as reasons, and nothing is stored", async () => {
    const w = await osWorld();
    googleGrants(w, "openid email");
    const url = new URL((await json(await post(w, "/acme/google/connect", { products: ["merchant"] }))).authorization_url);
    expect((await pub(w, `/google/callback?state=${url.searchParams.get("state")}&code=c`)).headers.get("location")).toContain("reason=scopes_declined");
    const url2 = new URL((await json(await post(w, "/acme/google/connect", { products: ["merchant"] }))).authorization_url);
    w.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    expect((await pub(w, `/google/callback?state=${url2.searchParams.get("state")}&code=c`)).headers.get("location")).toContain("reason=state_expired");
    expect(w.osStore.google.size).toBe(0);
  });

  it("refreshes on use; invalid_grant sets needs_reconnect and sends one alert to confirmed addresses only", async () => {
    const w = await osWorld();
    await connectGoogle(w);
    const { googleAccessToken } = await import("@/os/google");
    const fresh = await googleAccessToken(w.os, "acme");
    expect(fresh).toMatchObject({ ok: true, token: "fixture-access-2" });
    await w.osStore.putAlertAddress({ trooth_id: "acme", address: "ops@acme.com", state: "confirmed", token_hash: null, token_expires_at: null, added_at: NOW.toISOString(), confirmed_at: NOW.toISOString(), last_sent_at: null });
    await w.osStore.putAlertAddress({ trooth_id: "acme", address: "new@acme.com", state: "pending", token_hash: "x", token_expires_at: NOW.toISOString(), added_at: NOW.toISOString(), confirmed_at: null, last_sent_at: null });
    // The access token is reused until a minute before it expires (review enhancement); after that the refresh runs.
    expect(await googleAccessToken(w.os, "acme")).toMatchObject({ ok: true, token: "fixture-access-2" });
    expect(w.google.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(2);
    w.clock.now = new Date(NOW.getTime() + 3600_000);
    w.google.on("https://oauth2.googleapis.com/token", () => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }) }));
    expect(await googleAccessToken(w.os, "acme")).toMatchObject({ ok: false, reason: "needs_reconnect" });
    expect(await googleAccessToken(w.os, "acme")).toMatchObject({ ok: false, reason: "needs_reconnect" });
    expect(w.emails).toHaveLength(1);
    expect(w.emails[0]!.to).toEqual(["ops@acme.com"]);
    expect(w.emails[0]!.subject).toBe("Reconnect Google for acme.com");
    const view = await json(await get(w, "/acme/google"));
    expect(view.state).toBe("needs_reconnect");
    expect(view.last_error).toContain("Reconnect");
  });

  it("disconnects only with confirm, revokes at Google and deletes the sealed token", async () => {
    const w = await osWorld();
    await connectGoogle(w);
    w.google.on("https://oauth2.googleapis.com/revoke", () => ({ status: 200, body: "" }));
    expect((await post(w, "/acme/google/disconnect", {})).status).toBe(400);
    const r = await json(await post(w, "/acme/google/disconnect", { confirm: true }));
    expect(r).toMatchObject({ state: "not_connected", revoked_at_google: true });
    const revoke = w.google.calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke")!;
    expect(new URLSearchParams(revoke.init.body).get("token")).toBe("fixture-refresh-token");
    expect(w.osStore.google.size).toBe(0);
    expect(w.osStore.audit.map((a) => a.action)).toEqual(["google.connect.start", "google.connect", "google.disconnect"]);
  });
});

// ------------------------------------------------------------------------ 2. company settings

describe("2. company settings", () => {
  it("answers the signing policy, the surfaces (the website first) and the alert addresses", async () => {
    const w = await osWorld();
    const body = await json(await get(w, "/acme/company"));
    expect(body).toMatchObject({ object: "semanto.company_settings", signing_policy: { officers_required: 1 }, surfaces: [{ kind: "website", id: "website", label: "acme.com", url: "https://acme.com/", connected: true }], alert_addresses: [], recent_changes: [] });
  });

  it("two officers to one needs the owner, the typed words, and no version waiting for a second officer", async () => {
    const w = await osWorld();
    expect((await json(await post(w, "/acme/company/signing-policy", { officers_required: 2 }, "Bearer admin-token"))).signing_policy).toEqual({ officers_required: 2 });
    expect((await post(w, "/acme/company/signing-policy", { officers_required: 1, confirm: "one officer" }, "Bearer admin-token")).status).toBe(403);
    expect((await json(await post(w, "/acme/company/signing-policy", { officers_required: 1 }))).detail).toContain('"confirm": "one officer"');
    await post(w, "/acme/build", {});
    // An approval on file for the newest version: refused.
    const latest = (await w.store.latestVersion("acme"))!;
    await w.store.addAuthorization("acme", { record: { subject: "u-bo", role: "admin", name: "Bo Admin", since: NOW.toISOString() } as never, at: NOW.toISOString(), root_hash: latest.file.root_hash });
    const refused = await post(w, "/acme/company/signing-policy", { officers_required: 1, confirm: "one officer" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).detail).toContain("waiting for a second officer");
    await w.store.clearAuthorizations("acme", latest.file.root_hash);
    expect((await json(await post(w, "/acme/company/signing-policy", { officers_required: 1, confirm: "one officer" }))).signing_policy).toEqual({ officers_required: 1 });
    expect(w.osStore.audit.filter((a) => a.action === "company.signing_policy")).toHaveLength(2);
  });

  it("adds surfaces (Merchant Center sets the write-back target), and removing a connected one needs its id typed", async () => {
    const w = await osWorld();
    await connectGoogle(w);
    expect((await post(w, "/acme/company/surfaces", { add: { kind: "website", id: "x", label: "x" } })).status).toBe(400);
    expect((await post(w, "/acme/company/surfaces", { add: { kind: "merchant_center", id: "accounts/123456", label: "Acme Store", data_source: "bad" } })).status).toBe(400);
    const added = await json(await post(w, "/acme/company/surfaces", { add: { kind: "merchant_center", id: "accounts/123456", label: "Acme Store", data_source: "accounts/123456/dataSources/42", content_language: "en", feed_label: "US" } }));
    expect(added.surfaces[1]).toEqual({ kind: "merchant_center", id: "accounts/123456", label: "Acme Store", data_source: "accounts/123456/dataSources/42", connected: true });
    expect((await w.store.getConfig("acme")).writeback?.merchant_center).toEqual({ merchantId: "123456", contentLanguage: "en", targetCountry: "US", dataSource: "accounts/123456/dataSources/42" });
    expect((await post(w, "/acme/company/surfaces", { remove: "accounts/123456" })).status).toBe(400);
    expect((await post(w, "/acme/company/surfaces", { remove: "website" })).status).toBe(409);
    const removed = await json(await post(w, "/acme/company/surfaces", { remove: "accounts/123456", confirm: "accounts/123456" }));
    expect(removed.surfaces).toHaveLength(1);
    expect((await w.store.getConfig("acme")).writeback?.merchant_center).toBeUndefined();
  });

  it("alert addresses: pending until the emailed link is opened once within 24 hours; resend once a minute; remove with confirm", async () => {
    const w = await osWorld();
    expect((await post(w, "/acme/company/alerts", { add: "not an address" })).status).toBe(400);
    const added = await json(await post(w, "/acme/company/alerts", { add: "Ops@Acme.com" }));
    expect(added.alert_addresses).toEqual([{ address: "ops@acme.com", state: "pending", added_at: NOW.toISOString(), confirmed_at: null, resend_available_at: new Date(NOW.getTime() + 60_000).toISOString() }]);
    expect(w.emails).toHaveLength(1);
    const link = /https:\/\/api\.trooth\.co\/public\/semanto\/alerts\/confirm\?token=([A-Za-z0-9_-]+)/.exec(w.emails[0]!.text)!;
    expect(JSON.stringify([...w.osStore.alerts.values()])).not.toContain(link[1]);
    expect((await w.store.getConfig("acme")).alert_emails).toEqual([]);
    const resendTooSoon = await post(w, "/acme/company/alerts", { resend: "ops@acme.com" });
    expect(resendTooSoon.status).toBe(429);
    w.clock.now = new Date(NOW.getTime() + 61_000);
    expect((await post(w, "/acme/company/alerts", { resend: "ops@acme.com" })).status).toBe(200);
    const fresh = /token=([A-Za-z0-9_-]+)/.exec(w.emails[1]!.text)![1]!;
    // The first link was replaced by the resend: no address holds it any more, so it reads as link_invalid (review finding).
    expect((await pub(w, `/alerts/confirm?token=${link[1]}`)).headers.get("location")).toBe("https://trooth.co/dashboard/semanto/settings?alerts=error&reason=link_invalid");
    const confirmed = await pub(w, `/alerts/confirm?token=${fresh}`);
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get("location")).toBe("https://trooth.co/dashboard/semanto/settings?alerts=confirmed");
    expect((await w.store.getConfig("acme")).alert_emails).toEqual(["ops@acme.com"]);
    expect((await pub(w, `/alerts/confirm?token=${fresh}`)).headers.get("location")).toBe("https://trooth.co/dashboard/semanto/settings?alerts=error&reason=link_invalid");
    // A test alert goes to a confirmed address only, once a minute, and is in the audit trail.
    w.clock.now = new Date(w.clock.now.getTime() + 61_000);
    expect((await post(w, "/acme/company/alerts", { test: "ops@acme.com" })).status).toBe(200);
    expect(w.emails.at(-1)!.subject).toMatch(/^Test alert for /);
    expect((await post(w, "/acme/company/alerts", { test: "ops@acme.com" })).status).toBe(429);
    expect((await post(w, "/acme/company/alerts", { test: "nobody@acme.com" })).status).toBe(409);
    expect(w.osStore.audit.at(-1)).toMatchObject({ action: "company.alerts.test" });
    expect((await post(w, "/acme/company/alerts", { remove: "ops@acme.com" })).status).toBe(400);
    expect((await json(await post(w, "/acme/company/alerts", { remove: "ops@acme.com", confirm: "ops@acme.com" }))).alert_addresses).toEqual([]);
    expect((await w.store.getConfig("acme")).alert_emails).toEqual([]);
  });

  it("a link opened after 24 hours does not confirm, and without Resend the add answers a clear 409", async () => {
    const w = await osWorld();
    await post(w, "/acme/company/alerts", { add: "ops@acme.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(w.emails[0]!.text)![1]!;
    w.clock.now = new Date(NOW.getTime() + DAY_MS + 1);
    expect((await pub(w, `/alerts/confirm?token=${token}`)).headers.get("location")).toContain("reason=link_expired");
    const noEmail = await osWorld({ email: false });
    const r = await noEmail.app.request(`${OS}/acme/company/alerts`, { method: "POST", headers: { authorization: "Bearer owner-token" }, body: JSON.stringify({ add: "ops@acme.com" }) });
    expect(r.status).toBe(409);
    expect((await json(r)).detail).toContain("RESEND_API_KEY");
  });
});

// ------------------------------------------------------------------------ 3. write-back that sends

async function writebackWorld(opts: { queue?: boolean } = { queue: true }): Promise<OsWorld> {
  const w = await osWorld(opts);
  await buildAndSign(w);
  await connectGoogle(w);
  await post(w, "/acme/company/surfaces", { add: { kind: "merchant_center", id: "accounts/123456", label: "Acme Store", data_source: "accounts/123456/dataSources/42" } });
  await post(w, "/acme/company/surfaces", { add: { kind: "business_profile", id: "locations/987", label: "Acme Inc" } });
  const connector = await generateConnectorKey();
  await post(w, "/acme/connectors", { public_jwk: connector.publicJwk });
  await postCatalog(w, connector.privateJwk);
  const key = (await w.pipeline.d.keys.getCompanySigningKey("acme"))!;
  const at = NOW.toISOString();
  const record = await signProductRecord(
    { product_id: "601", sku: "ROC-200", brand: "Acme Inc", name: "Acme Rocket Skates", description: "Fixture skates.", attributes: [], regulatory: {}, media: [{ url: "https://cdn.acme.com/skates.png", hash: `sha256:${"a".repeat(64)}` }], url: "https://acme.com/products/skates", variant_axes: {}, provenance: "declared", evidence: { url: "https://acme.com/products/skates", witnessed_at: at }, not_before: at },
    key,
    { iat: NOW },
  );
  await w.commerce.putRecord("acme", record);
  w.probes["https://cdn.acme.com/skates.png"] = { status: 200, headers: { "content-type": "image/png" }, body: new TextEncoder().encode("fixture png bytes") };
  return w;
}

describe("3. write-back that sends", () => {
  it("every preview payload carries an item_id; the Merchant Center payload is the Merchant API form that is sent; only http payloads are sendable", async () => {
    const w = await writebackWorld();
    const r = await json(await get(w, "/acme/writeback"));
    expect(r.object).toBe("semanto.writeback_preview");
    const payloads = r.payloads as { item_id: string; connector: string; transport: string; method: string | null; url: string | null; sendable: boolean; blocked_by?: string; body: string; dry_run: string; needs: string; content_type: string }[];
    expect(payloads.every((p) => /^wbi_[0-9a-f]{32}$/.test(p.item_id))).toBe(true);
    const sendable = payloads.filter((p) => p.sendable);
    expect(sendable.map((p) => p.connector)).toEqual(["merchant_center", "business_profile"]);
    const mc = sendable[0]!;
    expect(mc).toMatchObject({ transport: "http", method: "POST", url: "https://merchantapi.googleapis.com/products/v1/accounts/123456/productInputs:insert?dataSource=accounts%2F123456%2FdataSources%2F42", content_type: "application/json", needs: "oauth_token" });
    expect(JSON.parse(mc.body).productInputs.map((p: { offerId: string }) => p.offerId).sort()).toEqual(["ANV-100", "ROC-200"]);
    expect(payloads.find((p) => p.transport === "file")).toMatchObject({ sendable: false, blocked_by: expect.stringContaining("file") });
    // The same change keeps the same id.
    expect((await json(await get(w, "/acme/writeback"))).payloads.map((p: { item_id: string }) => p.item_id)).toEqual(payloads.map((p) => p.item_id));
  });

  it("QA-14: a change the Google connection was not granted for is not sendable, with the reason, before Send", async () => {
    const w = await writebackWorld();
    const g = (await w.osStore.getGoogle("acme"))!;
    await w.osStore.putGoogle({ ...g, products: ["merchant"] });
    const payloads = (await json(await get(w, "/acme/writeback"))).payloads as { connector: string; sendable: boolean; blocked_by?: string }[];
    expect(payloads.find((p) => p.connector === "business_profile")).toMatchObject({ sendable: false, blocked_by: expect.stringContaining("without Business Profile access") });
    expect(payloads.find((p) => p.connector === "merchant_center")?.sendable).toBe(true);
  });

  it("QA-19: a run names who sent it as Recent changes does, never the internal user id", async () => {
    const w = await writebackWorld();
    const r = await json(await post(w, "/acme/writeback/send", { confirm: true, idempotency_key: "qa19-send-0001" }));
    const runs = await json(await get(w, "/acme/writeback/runs"));
    expect(runs.runs[0].created_by).toBe("Ada Owner");
    expect(JSON.stringify(runs)).not.toContain("u-ada");
    expect(r.run_id).toBe(runs.runs[0].run_id);
  });

  it("sends with confirm and an idempotency key, one queue message per item; the same key answers the same run", async () => {
    const w = await writebackWorld();
    const ids = (await json(await get(w, "/acme/writeback"))).payloads.filter((p: { sendable: boolean }) => p.sendable).map((p: { item_id: string }) => p.item_id) as string[];
    expect((await post(w, "/acme/writeback/send", { item_ids: ids, idempotency_key: "send-0001" })).status).toBe(400);
    expect((await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true })).status).toBe(400);
    expect((await post(w, "/acme/writeback/send", { item_ids: ["wbi_unknown"], confirm: true, idempotency_key: "send-0000" })).status).toBe(409);
    const file = (await json(await get(w, "/acme/writeback"))).payloads.find((p: { transport: string }) => p.transport === "file").item_id;
    expect((await json(await post(w, "/acme/writeback/send", { item_ids: [file], confirm: true, idempotency_key: "send-file" }))).detail).toContain("file");
    const sent = await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true, idempotency_key: "send-0001" });
    expect(sent.status).toBe(202);
    const run = await json(sent);
    expect(run.items).toEqual(ids.map((item_id) => ({ item_id, state: "queued" })));
    expect(w.queued).toEqual(ids.map((item_id) => ({ kind: "writeback", trooth_id: "acme", run_id: run.run_id, item_id })));
    const again = await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true, idempotency_key: "send-0001" });
    expect(again.status).toBe(200);
    expect((await json(again)).run_id).toBe(run.run_id);
    expect(w.queued).toHaveLength(ids.length);
  });

  it("the consumer sends through the Merchant API and the Business Profile API with a token refreshed on use, then queues a credential per image", async () => {
    const w = await writebackWorld();
    w.google.on("https://merchantapi.googleapis.com/products/v1/", () => ({ status: 200, body: "{}" }));
    w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987", () => ({ status: 200, body: "{}" }));
    const ids = (await json(await get(w, "/acme/writeback"))).payloads.filter((p: { sendable: boolean }) => p.sendable).map((p: { item_id: string }) => p.item_id) as string[];
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true, idempotency_key: "send-0002" }));
    await drain(w);
    const inserts = w.google.calls.filter((c) => c.url.startsWith("https://merchantapi.googleapis.com/products/v1/"));
    expect(inserts).toHaveLength(2);
    const mc = inserts.find((c) => JSON.parse(c.init.body!).offerId === "ROC-200")!;
    expect(mc.url).toBe("https://merchantapi.googleapis.com/products/v1/accounts/123456/productInputs:insert?dataSource=accounts%2F123456%2FdataSources%2F42");
    expect(mc.init.method).toBe("POST");
    expect(mc.init.headers.authorization).toBe("Bearer fixture-access-2");
    const input = JSON.parse(mc.init.body!);
    expect(input).toMatchObject({ offerId: "ROC-200", contentLanguage: "en", feedLabel: "US", productAttributes: { title: "Acme Rocket Skates", link: "https://acme.com/products/skates", imageLink: "https://cdn.acme.com/skates.png", availability: "IN_STOCK" } });
    const bp = w.google.calls.find((c) => c.url.startsWith("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987"))!;
    expect(bp.init.method).toBe("PATCH");
    expect(bp.url).toContain("updateMask=");
    const detail = await json(await get(w, `/acme/writeback/runs/${run.run_id}`));
    expect(detail.items.map((i: { state: string }) => i.state)).toEqual(["sent", "sent"]);
    expect(detail.items[0]).toMatchObject({ connector: "merchant_center", target: "accounts/123456", sent_at: NOW.toISOString(), dry_run: expect.stringContaining("Merchant API") });
    const creds = await json(await get(w, "/acme/credentials"));
    expect(creds.rows).toContainEqual(expect.objectContaining({ asset_url: "https://cdn.acme.com/skates.png", source: "writeback", state: "made", kind: "image/png" }));
    const runs = await json(await get(w, "/acme/writeback/runs"));
    expect(runs.runs[0]).toMatchObject({ run_id: run.run_id, items: [{ connector: "merchant_center", state: "sent" }, { connector: "business_profile", state: "sent" }] });
    expect(runs.next_cursor).toBeNull();
  });

  it("retries 429 and 5xx after 30, 120 and 600 seconds, then fails in plain words; a 4xx fails with Google's message; a run's failed items can be sent again", async () => {
    const w = await writebackWorld();
    let busy = true;
    w.google.on("https://merchantapi.googleapis.com/products/v1/", () => (busy ? { status: 503, body: JSON.stringify({ error: { code: 503, message: "The service is currently unavailable." } }) } : { status: 200, body: "{}" }));
    w.google.on("https://mybusinessbusinessinformation.googleapis.com/v1/locations/987", () => ({ status: 400, body: JSON.stringify({ error: { code: 400, message: "Request contains an invalid argument." } }) }));
    const ids = (await json(await get(w, "/acme/writeback"))).payloads.filter((p: { sendable: boolean }) => p.sendable).map((p: { item_id: string }) => p.item_id) as string[];
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: ids, confirm: true, idempotency_key: "send-0003" }));
    const [mcMsg, bpMsg] = w.queued.splice(0) as Record<string, unknown>[];
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await w.pipeline.consume(mcMsg, attempt);
      } catch (e) {
        expect(e).toBeInstanceOf(RetryLater);
        delays.push((e as RetryLater).delaySeconds);
      }
      expect((await w.osStore.getWritebackItem(run.run_id, ids[0]!))!.state).toBe("retrying");
    }
    expect(delays).toEqual([...BACKOFF_SECONDS]);
    await w.pipeline.consume(mcMsg, 4);
    const failed = (await w.osStore.getWritebackItem(run.run_id, ids[0]!))!;
    expect(failed).toMatchObject({ state: "failed", attempts: 4 });
    expect(failed.last_error).toContain("The service is currently unavailable.");
    expect(failed.last_error).toContain("0 of 2 were sent before it");
    await w.pipeline.consume(bpMsg, 1);
    expect((await w.osStore.getWritebackItem(run.run_id, ids[1]!))).toMatchObject({ state: "failed", last_error: "Google refused this change (400): Request contains an invalid argument." });
    expect((await post(w, `/acme/writeback/runs/${run.run_id}/retry`, { item_ids: ["wbi_nope"] })).status).toBe(409);
    busy = false;
    const retried = await post(w, `/acme/writeback/runs/${run.run_id}/retry`, { item_ids: [ids[0]] });
    expect(retried.status).toBe(202);
    await drain(w);
    expect((await w.osStore.getWritebackItem(run.run_id, ids[0]!))!.state).toBe("sent");
    expect((await post(w, `/acme/writeback/runs/${run.run_id}/retry`, { item_ids: [ids[0]] })).status).toBe(409);
  });

  it("invalid_grant fails the item as needs_reconnect, and send is refused until Google is connected again", async () => {
    const w = await writebackWorld();
    const ids = (await json(await get(w, "/acme/writeback"))).payloads.filter((p: { sendable: boolean }) => p.sendable).map((p: { item_id: string }) => p.item_id) as string[];
    const run = await json(await post(w, "/acme/writeback/send", { item_ids: [ids[1]], confirm: true, idempotency_key: "send-0004" }));
    w.google.on("https://oauth2.googleapis.com/token", () => ({ status: 400, body: JSON.stringify({ error: "invalid_grant" }) }));
    await drain(w);
    expect((await w.osStore.getWritebackItem(run.run_id, ids[1]!))!.last_error).toMatch(/^needs_reconnect: /);
    const refused = await post(w, "/acme/writeback/send", { item_ids: [ids[1]], confirm: true, idempotency_key: "send-0005" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).detail).toContain("Reconnect");
  });

  it("the queue consumer passes delaySeconds to message.retry", async () => {
    const calls: unknown[] = [];
    const ports = { jobs: { compile: async () => { throw new RetryLater(120, "busy"); }, failed: async () => undefined } } as never;
    await runQueue(ports, [{ body: {}, attempts: 2, ack: () => calls.push("ack"), retry: (o?: { delaySeconds?: number }) => calls.push(o) }]);
    expect(calls).toEqual([{ delaySeconds: 120 }]);
  });
});

// ------------------------------------------------------------------------ 4. seller lists

describe("4. seller lists", () => {
  const list = (version: number, over: Record<string, unknown> = {}) => ({ trooth_id: "acme", version, issued_at: NOW.toISOString(), sellers: [{ seller_id: "s-1", name: "Fixture Outlet", domain: "outlet.example", authorized_from: "2026-01-01T00:00:00.000Z" }, { seller_id: "s-2", name: "Market Shop", marketplace: "amazon", authorized_from: "2026-01-01T00:00:00.000Z", authorized_until: "2026-06-01T00:00:00.000Z" }], ...over });

  it("customer custody: a JWS checked against the key valid at issued_at; a bad signature is 422 and stores nothing; versions only go up", async () => {
    const w = await osWorld({ custody: "customer" });
    const k = await generateKeyPair();
    await post(w, "/acme/keys/rotate", { public_jwk: k.publicJwk });
    const stranger = await generateKeyPair();
    const bad = await signObject(list(1), { ...stranger.privateJwk, kid: k.publicJwk.kid }, JWS_TYPES.sellerList, { iat: NOW });
    const r = await post(w, "/acme/sellers/lists", { jws: bad.compact });
    expect(r.status).toBe(422);
    expect((await json(r)).code).toBe("seller_list_signature");
    expect(w.osStore.sellerRows).toHaveLength(0);
    const wrongType = await signObject(list(1), k.privateJwk, JWS_TYPES.offer, { iat: NOW });
    expect((await post(w, "/acme/sellers/lists", { jws: wrongType.compact })).status).toBe(422);
    expect((await post(w, "/acme/sellers/lists", { jws: (await signObject(list(1, { trooth_id: "beta" }), k.privateJwk, JWS_TYPES.sellerList)).compact })).status).toBe(400);
    const good = await signObject(list(1), k.privateJwk, JWS_TYPES.sellerList, { iat: NOW });
    const ok = await post(w, "/acme/sellers/lists", { jws: good.compact });
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({ object: "semanto.seller_list", version: 1, state: "valid", kid: k.publicJwk.kid, sellers: 2, custody: "customer" });
    const same = await post(w, "/acme/sellers/lists", { jws: good.compact });
    expect(same.status).toBe(409);
    expect((await json(same)).detail).toContain("only go up");
    await post(w, "/acme/sellers/lists", { jws: (await signObject(list(2), k.privateJwk, JWS_TYPES.sellerList, { iat: NOW })).compact });
    const versions = await json(await get(w, "/acme/sellers/lists"));
    expect(versions.lists.map((v: { version: number; state: string }) => [v.version, v.state])).toEqual([[2, "valid"], [1, "superseded"]]);
    expect(versions.lists[0]).toMatchObject({ issued_at: NOW.toISOString(), sellers_count: 2, received_at: NOW.toISOString(), kid: k.publicJwk.kid, reason: null });
  });

  it("hosted custody: the server signs a draft after a passkey assertion bound to that exact draft", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const draft = list(1);
    expect((await json(await post(w, "/acme/sellers/lists", { draft }))).code).toBe("passkey_cancelled");
    const otherDraft = await purposeAssertion(w, { purpose: "seller_list", draft: list(1, { issued_at: "2026-10-23T11:00:00.000Z" }) });
    expect((await json(await post(w, "/acme/sellers/lists", { draft, assertion: otherDraft }))).code).toBe("passkey_invalid");
    const assertion = await purposeAssertion(w, { purpose: "seller_list", draft });
    const r = await post(w, "/acme/sellers/lists", { draft, assertion });
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(body).toMatchObject({ version: 1, state: "valid", custody: "hosted" });
    expect(JSON.parse(Buffer.from(body.jws.split(".")[1], "base64url").toString())).toEqual(JSON.parse(canonicalize(draft)));
  });

  it("the public sellers route and the authorization check read the newest valid list only", async () => {
    const w = await osWorld({ custody: "customer" });
    const k = await generateKeyPair();
    await post(w, "/acme/keys/rotate", { public_jwk: k.publicJwk });
    await post(w, "/acme/sellers/lists", { jws: (await signObject(list(1), k.privateJwk, JWS_TYPES.sellerList, { iat: NOW })).compact });
    await post(w, "/acme/sellers/lists", { jws: (await signObject(list(2, { sellers: [{ seller_id: "s-9", name: "New Shop", domain: "newshop.example", authorized_from: "2026-01-01T00:00:00.000Z" }] }), k.privateJwk, JWS_TYPES.sellerList, { iat: NOW })).compact });
    const whole = await json(await pub(w, "/acme/sellers"));
    expect(whole).toMatchObject({ object: "semanto.seller_list", version: 2, kid: k.publicJwk.kid });
    expect(whole.sellers.map((s: { seller_id: string }) => s.seller_id)).toEqual(["s-9"]);
    expect(await json(await pub(w, "/acme/sellers?domain=newshop.example&sku=ANV-100"))).toMatchObject({ object: "semanto.seller_authorization", state: "authorized", seller_id: "s-9", list_version: 2 });
    expect(await json(await pub(w, "/acme/sellers?domain=outlet.example"))).toMatchObject({ state: "not_listed", list_version: 2 });
  });
});

// ------------------------------------------------------------------------ 5. recall events to worker-f

describe("5. recalls into worker-f's changes feed (sender side)", () => {
  async function recall(w: OsWorld, statement = "Stop using the Acme Anvil. It can fall.") {
    const key = (await w.pipeline.d.keys.getCompanySigningKey("acme"))!;
    return signRecall({ skus: ["ANV-100"], issued_at: "2026-10-23T10:00:00.000Z", authority: { name: "U.S. Consumer Product Safety Commission", url: "https://www.cpsc.gov/Recalls/fixture" }, action: "stop_use", statement, url: "https://acme.com/recalls/anvil" }, key);
  }

  it("a stored recall is posted through TROOTH_OS with the HMAC header, a deterministic event_id, and a repeat is a no-op", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    await postCatalog(w, k.privateJwk);
    const signed = await recall(w);
    await w.commerce.putRecall("acme", signed);
    expect(w.workerF.requests).toHaveLength(1);
    const req = w.workerF.requests[0]!;
    expect(req.url).toBe("https://os/internal/semanto/recall-events");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["trooth-event-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await checkEventSignature(EVENTS_SECRET, req.headers["trooth-event-signature"]!, req.body, NOW)).toBe(true);
    expect(await checkEventSignature("another-secret", req.headers["trooth-event-signature"]!, req.body, NOW)).toBe(false);
    expect(await checkEventSignature(EVENTS_SECRET, req.headers["trooth-event-signature"]!, req.body, new Date(NOW.getTime() + 301_000))).toBe(false);
    const body = JSON.parse(req.body);
    const records = await w.commerce.records("acme");
    expect(body).toEqual({
      event_id: await recallEventId("acme", signed.notice),
      trooth_id: "acme",
      os_company_id: "co-acme",
      domain: "acme.com",
      recall: { recall_id: signed.notice.id, product_record_id: records.find((r) => r.record.sku === "ANV-100")!.record.id, gtin: "00012345678905", title: "Stop using the Acme Anvil.", remedy: "Stop using it.", published_at: "2026-10-23T10:00:00.000Z", source_url: "https://www.cpsc.gov/Recalls/fixture", provenance: "public_record" },
      emitted_at: NOW.toISOString(),
    });
    expect(body.event_id).toMatch(/^[0-9a-f]{64}$/);
    await w.commerce.putRecall("acme", signed);
    expect(w.workerF.requests).toHaveLength(1);
    // A changed recall is a new event.
    await w.commerce.putRecall("acme", await recall(w, "Stop using the Acme Anvil. It can fall. Return it for a refund."));
    expect(w.workerF.requests).toHaveLength(2);
  });

  it("a recall worker-f could not file is kept as failed with the reason, and a 4xx other than 429 is not retried", async () => {
    const w = await osWorld({ queue: true });
    await buildAndSign(w);
    await w.commerce.putRecall("acme", await recall(w));
    expect(w.workerF.requests).toHaveLength(0);
    const kept = [...w.osStore.recallEvents.values()][0]!;
    expect(kept).toMatchObject({ state: "failed" });
    expect(kept.last_error).toContain("no product record");
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    await postCatalog(w, k.privateJwk);
    w.workerF.status = 400;
    await w.commerce.putRecall("acme", await recall(w, "Stop using the Acme Anvil. Another statement."));
    expect(w.workerF.requests).toHaveLength(1);
    expect(w.queued.filter((m) => (m as { kind?: string }).kind === "recall_event")).toHaveLength(0);
    expect([...w.osStore.recallEvents.values()].at(-1)).toMatchObject({ state: "failed", last_error: "worker-f answered 400." });
  });

  it("a failed send is queued as recall_event and retried with the same body after 30, 120 and 600 seconds", async () => {
    const w = await osWorld({ queue: true });
    await buildAndSign(w);
    const k = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: k.publicJwk });
    await postCatalog(w, k.privateJwk);
    w.workerF.status = 503;
    const signed = await recall(w);
    await w.commerce.putRecall("acme", signed);
    const msg = w.queued.find((m) => (m as { kind?: string }).kind === "recall_event") as Record<string, unknown>;
    expect(msg).toEqual({ kind: "recall_event", trooth_id: "acme", event_id: await recallEventId("acme", signed.notice) });
    await expect(w.pipeline.consume(msg, 1)).rejects.toMatchObject({ delaySeconds: 30 });
    await expect(w.pipeline.consume(msg, 2)).rejects.toMatchObject({ delaySeconds: 120 });
    w.workerF.status = 200;
    await w.pipeline.consume(msg, 3);
    // The first send in the request, then the three queue attempts, all with the same body.
    expect(w.workerF.requests).toHaveLength(4);
    expect(new Set(w.workerF.requests.map((r) => r.body)).size).toBe(1);
    expect((await w.osStore.getRecallEvent(String(msg.event_id)))).toMatchObject({ state: "sent", attempts: 4 });
  });
});

// ------------------------------------------------------------------------ 6. C2PA credentials

describe("6. C2PA credentials in jobs", () => {
  it("a build queues one credential job per image and PDF in its documents; the job stores the manifest and the public route serves it", async () => {
    const w = await osWorld({ queue: true });
    const seen: string[] = [];
    const hook = w.pipeline.d.afterAssembled!;
    (w.pipeline.d as { afterAssembled?: typeof hook }).afterAssembled = async (id, file) => {
      seen.push(`${id} v${file.header.version}`);
      await hook(id, { ...file, documents: [
        { url: "https://acme.com/brochure.pdf", title: "Brochure", kind: "pdf", hash: `sha256:${"b".repeat(64)}`, bytes: 10, witnessed_at: NOW.toISOString() },
        { url: "https://acme.com/logo.png", title: "Logo", kind: "other", hash: `sha256:${"c".repeat(64)}`, bytes: 10, witnessed_at: NOW.toISOString() },
        { url: "https://acme.com/notes.txt", title: "Notes", kind: "other", hash: `sha256:${"d".repeat(64)}`, bytes: 10, witnessed_at: NOW.toISOString() },
      ] });
    };
    await buildAndSign(w);
    expect(seen).toEqual(["acme v1"]);
    // The fixture site has no documents of its own: give the signed version the same two and run a job against it.
    const file = (await w.versions.getCurrent("acme"))!;
    (file as { documents: unknown[] }).documents = [
      { url: "https://acme.com/brochure.pdf", title: "Brochure", kind: "pdf", hash: `sha256:${"b".repeat(64)}`, bytes: 10, witnessed_at: NOW.toISOString() },
      { url: "https://acme.com/logo.png", title: "Logo", kind: "other", hash: `sha256:${"c".repeat(64)}`, bytes: 10, witnessed_at: NOW.toISOString() },
    ];
    const { processCredential } = await import("@/os/credentials");
    await processCredential(w.os, { kind: "credential", trooth_id: "acme", asset_url: "https://acme.com/brochure.pdf", source: "compile" });
    const list = await json(await get(w, "/acme/credentials?state=made"));
    expect(list.rows[0]).toMatchObject({ asset_url: "https://acme.com/brochure.pdf", sha256: "b".repeat(64), kind: "application/pdf", source: "compile", state: "made", manifest_url: `${API}/acme/credentials/${"b".repeat(64)}` });
    expect(w.osStore.blobs.has(`credentials/acme/${"b".repeat(64)}.c2pa`)).toBe(true);
    const served = await json(await pub(w, `/acme/credentials/${"b".repeat(64)}`));
    expect(served).toMatchObject({ object: "semanto.c2pa_manifest", sha256: "b".repeat(64), asset_url: "https://acme.com/brochure.pdf" });
    expect(served.manifest.assertions.map((a: { label: string }) => a.label)).toContain("co.trooth.semanto");
    expect((await pub(w, `/acme/credentials/${"f".repeat(64)}`)).status).toBe(404);
    expect((await pub(w, "/acme/credentials/not-a-digest")).status).toBe(404);
  });

  it("records failed and skipped assets, with totals and a cursor", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const { processCredential } = await import("@/os/credentials");
    await processCredential(w.os, { kind: "credential", trooth_id: "acme", asset_url: "https://cdn.acme.com/missing.png", source: "writeback" });
    await processCredential(w.os, { kind: "credential", trooth_id: "acme", asset_url: "https://acme.com/page.html", source: "writeback" });
    const body = await json(await get(w, "/acme/credentials"));
    // The build's own job for /plant.jpg (linked from the about page, not served here) is the second failed row (QA-13).
    expect(body.totals).toEqual({ made: 0, failed: 2, skipped: 1 });
    expect(body.rows.find((r: { state: string; asset_url: string }) => r.asset_url === "https://cdn.acme.com/missing.png").reason).toContain("could not be read");
    expect(body.rows.find((r: { asset_url: string }) => r.asset_url === "https://acme.com/plant.jpg").state).toBe("failed");
    expect(body.next_cursor).toBeNull();
    expect((await get(w, "/acme/credentials?state=broken")).status).toBe(400);
  });
});

// ------------------------------------------------------------------------ house rules on the new answers

describe("house rules on the contract's answers", () => {
  it("no banned word and no ellipsis in the problem sentences and plain answers of the new modules", async () => {
    const { PASTE_MESSAGES } = await import("@/os/connectors");
    const text = JSON.stringify(PASTE_MESSAGES) + PASTE_MESSAGES.duplicate("kid");
    expect(BANNED_WORDS.test(text)).toBe(false);
    expect(ELLIPSIS.test(text)).toBe(false);
    expect(SEAL.length).toBeGreaterThanOrEqual(32);
  });
});
