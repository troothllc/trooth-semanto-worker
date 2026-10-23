// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's Trooth client against the real Semanto Worker, wired in memory by
// the Worker's own test world (test/helpers/os-world.ts, src/os,
// src/serve/os-routes.ts, the catalog handler in src/pipeline.ts): open a
// connect session, poll it, approve it as the company owner, post a catalog
// signed with the shop's key (Trooth signs the records), revoke the key on
// uninstall, and see a never-registered key refused and counted as nothing
// to revoke. The Worker is loaded at run time (the address is not a literal)
// so this package's typecheck does not compile the Worker; the Worker
// typechecks itself.

import { describe, expect, it } from "vitest";
import { TroothClient } from "../app/lib/trooth-client";
import { generateConnectorKey, publicOf } from "../app/lib/sign";
import { catalogDocument, mapProduct, markDiscontinued } from "../app/lib/mapping";
import { RevokeRefused } from "../app/lib/trooth-client";
import { fixtureProduct } from "./fixtures/mock-shopify";

interface World {
  app: { request(url: string, init?: RequestInit): Promise<Response> | Response };
  clock: { now: Date };
}
interface OsWorldModule {
  osWorld(opts?: Record<string, unknown>): Promise<World>;
  buildAndSign(w: World): Promise<void>;
  post(w: World, path: string, body: unknown): Promise<Response>;
  get(w: World, path: string): Promise<Response>;
  API: string;
}

async function workerWorld(): Promise<OsWorldModule> {
  const address = ["..", "..", "..", "test", "helpers", "os-world"].join("/");
  return (await import(/* @vite-ignore */ new URL(address, import.meta.url).href)) as OsWorldModule;
}

const SHOP = "acme-store.myshopify.com";

describe("the app against the real Semanto Worker (contract 1d and 7)", () => {
  it("connect, approve, catalog, uninstall: every shape and signature the app uses is the one the Worker answers and accepts", async () => {
    const m = await workerWorld();
    const w = await m.osWorld();
    await m.buildAndSign(w);
    const apiBase = m.API.replace(/\/public\/semanto$/, "");
    const client = new TroothClient(apiBase, "https://trooth.co/dashboard/semanto", async (url, init) => w.app.request(url, init), { sleep: async () => undefined }, () => w.clock.now);

    const { privateJwk } = await generateConnectorKey();
    const session = await client.createConnectSession(SHOP, publicOf(privateJwk), `https://${SHOP}/admin/apps/semanto-by-trooth`);
    expect(session.approve_url).toBe(`https://trooth.co/dashboard/semanto/connect/${session.session_id}`);
    expect(await client.pollConnectSession(session.session_id, session.poll_token)).toEqual({ state: "pending" });
    expect(await client.pollConnectSession(session.session_id, "not-the-token")).toEqual({ state: "expired" });

    const approved = await m.post(w, `/acme/connect/${session.session_id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(await client.pollConnectSession(session.session_id, session.poll_token)).toEqual({ state: "approved", trooth_id: "acme", kid: privateJwk.kid });

    const doc = catalogDocument(SHOP, { name: "Acme Store", url: "https://acme.com", currencyCode: "USD" }, "acme", [mapProduct(fixtureProduct(1), "https://acme.com"), mapProduct(fixtureProduct(2, { variants: 2 }), "https://acme.com")], w.clock.now);
    const receipt = await client.postCatalog("acme", doc, privateJwk);
    expect(receipt).toMatchObject({ signed: true, records: 3, offers: 3, skipped: 0, removed: 0 });
    // A product sent as discontinued removes every offer for its sku and is listed in removed.
    const gone = await client.postCatalog("acme", catalogDocument(SHOP, { name: "Acme Store", url: "https://acme.com", currencyCode: "USD" }, "acme", [markDiscontinued(mapProduct(fixtureProduct(1), "https://acme.com"))], w.clock.now), privateJwk);
    expect(gone).toMatchObject({ removed: 1, offers: 0 });

    expect(await client.revoke(SHOP, privateJwk, "acme", "shop_redact")).toBe("revoked");
    const keys = (await (await m.get(w, "/acme/connectors")).json()) as { keys: { kid: string; revoked_at: string | null }[] };
    expect(keys.keys.find((k) => k.kid === privateJwk.kid)!.revoked_at).not.toBeNull();
    // A second uninstall (Shopify may deliver twice) answers the same revocation.
    expect(await client.revoke(SHOP, privateJwk, "acme", "uninstalled")).toBe("revoked");
    // A revoked key can no longer send a catalog.
    await expect(client.postCatalog("acme", doc, privateJwk)).rejects.toThrow();
  });

  it("an abandoned or declined connection's key, never registered, is refused by the Worker and counted as nothing to revoke", async () => {
    const m = await workerWorld();
    const w = await m.osWorld();
    const client = new TroothClient(m.API.replace(/\/public\/semanto$/, ""), "https://trooth.co/dashboard/semanto", async (url, init) => w.app.request(url, init), { sleep: async () => undefined }, () => w.clock.now);
    const { privateJwk } = await generateConnectorKey();
    const session = await client.createConnectSession(SHOP, publicOf(privateJwk), `https://${SHOP}/admin/apps/semanto-by-trooth`);
    await m.post(w, `/acme/connect/${session.session_id}/deny`, {});
    expect(await client.pollConnectSession(session.session_id, session.poll_token)).toEqual({ state: "denied" });
    expect(await client.revoke(SHOP, privateJwk, null, "disconnected")).toBe("not_registered");
    w.clock.now = new Date(w.clock.now.getTime() + 16 * 60 * 1000);
    const late = await generateConnectorKey();
    const s2 = await client.createConnectSession(SHOP, publicOf(late.privateJwk), `https://${SHOP}/admin/apps/semanto-by-trooth`);
    w.clock.now = new Date(w.clock.now.getTime() + 15 * 60 * 1000);
    expect(await client.pollConnectSession(s2.session_id, s2.poll_token)).toEqual({ state: "expired" });
  });

  it("a request the app withdrew (uninstalled before approval) reads as expired on the app's connect screen, and cannot be approved", async () => {
    const m = await workerWorld();
    const w = await m.osWorld();
    const client = new TroothClient(m.API.replace(/\/public\/semanto$/, ""), "https://trooth.co/dashboard/semanto", async (url, init) => w.app.request(url, init), { sleep: async () => undefined }, () => w.clock.now);
    const { privateJwk } = await generateConnectorKey();
    const session = await client.createConnectSession(SHOP, publicOf(privateJwk), `https://${SHOP}/admin/apps/semanto-by-trooth`);
    expect(await client.revoke(SHOP, privateJwk, null, "uninstalled")).toBe("not_registered");
    const raw = (await (await w.app.request(`${m.API}/connect/sessions/${session.session_id}`, { headers: { authorization: `Bearer ${session.poll_token}` } })).json()) as { state: string };
    expect(raw.state).toBe("withdrawn");
    expect(await client.pollConnectSession(session.session_id, session.poll_token)).toEqual({ state: "expired" });
    expect((await m.post(w, `/acme/connect/${session.session_id}/approve`, {})).status).toBe(409);
  });

  it("a key pasted in the dashboard by hand is refused (403) and the app reports it as a refusal, not as done", async () => {
    const m = await workerWorld();
    const w = await m.osWorld();
    const client = new TroothClient(m.API.replace(/\/public\/semanto$/, ""), "https://trooth.co/dashboard/semanto", async (url, init) => w.app.request(url, init), { sleep: async () => undefined }, () => w.clock.now);
    const { privateJwk } = await generateConnectorKey();
    const pasted = await m.post(w, "/acme/connectors", { public_jwk: JSON.stringify(publicOf(privateJwk)), label: "Pasted by hand", source: "api" });
    expect(pasted.status).toBe(200);
    const refused = await client.revoke(SHOP, privateJwk, "acme", "disconnected").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RevokeRefused);
    expect((refused as RevokeRefused).status).toBe(403);
  });
});
