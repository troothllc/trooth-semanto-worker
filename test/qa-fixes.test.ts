// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Regression tests for the defects the QA walk found (docs/program/reports/qa.md),
// one block per defect, each named by its QA number. The walk itself runs the
// real Worker under workerd (qa/stack.mjs); these hold each fix in the suite.

import { describe, expect, it } from "vitest";
import { osWorld, buildAndSign, get, post, json } from "./helpers/os-world";
import { SessionUnavailable } from "@/serve/errors";
import { troothOsSession } from "@/pipeline";
import { pageMediaUrls } from "@/os/credentials";
import { DEV_UPSTREAM_HOSTS, devDashboardBase, devUpstreamBase, devUpstreamFetch } from "@/dev-upstream";

/** A clock that moves forward on every read, as workerd's does across I/O (Date.now() advances after each await of I/O). */
function tickingClock(w: { clock: { now: Date } }, stepMs = 7): void {
  let t = w.clock.now.getTime();
  Object.defineProperty(w.clock, "now", { get: () => new Date((t += stepMs)), set: (d: Date) => void (t = d.getTime()), configurable: true });
}

describe("QA-01: the first hosted signature of a company is valid when the clock moves during the request", () => {
  it("signs version 1 on the first try, with the key's nbf no later than the statement's iat", async () => {
    const w = await osWorld({ custody: "hosted" });
    tickingClock(w);
    await buildAndSign(w);
    const keys = await json(await get(w, "/acme/keys"));
    expect(keys.keys.length).toBe(1);
    const latest = await w.store.latestVersion("acme");
    expect(latest?.file.header.state).toBe("signed");
  });
});

describe("QA-03: the install check accepts the /.well-known files the repository's own adapter serves", () => {
  it("networkCopy equals, byte for byte, what adapters/shared/semanto-adapter.mjs answers for both files", async () => {
    const w = await osWorld({ custody: "hosted" });
    await buildAndSign(w);
    const adapter = await import("../adapters/shared/semanto-adapter.mjs");
    const viaAdapter = async (path: string) =>
      new Uint8Array(
        await (
          await adapter.handleRequest({
            request: new Request(`https://acme.com${path}`),
            config: { troothId: "acme", apiBase: "https://api.trooth.co", mode: "semanto_only" },
            manifestCache: null,
            fetchImpl: ((u: string, i: RequestInit) => w.app.request(u, i)) as unknown as typeof fetch,
            next: async () => new Response("the site"),
          })
        ).arrayBuffer(),
      );
    const company = (await w.store.getCompany("acme"))!;
    const copy = await w.pipeline.networkCopy(company);
    expect(Buffer.from(await viaAdapter("/.well-known/trooth.semanto")).equals(Buffer.from(copy.semanto))).toBe(true);
    expect(Buffer.from(await viaAdapter("/.well-known/trooth-keys.json")).equals(Buffer.from(copy.keys))).toBe(true);
  });
});

describe("QA-10: only an owner or admin adds a signing passkey", () => {
  it("refuses a member and a viewer, before any challenge is stored, and lets an admin start", async () => {
    const w = await osWorld({ custody: "hosted" });
    await buildAndSign(w);
    for (const token of ["Bearer member-token", "Bearer viewer-token"]) {
      expect((await post(w, "/acme/passkeys/options", {}, token)).status).toBe(403);
      expect((await post(w, "/acme/passkeys", { credential: {} }, token)).status).toBe(403);
    }
    expect((await post(w, "/acme/passkeys/options", {}, "Bearer admin-token")).status).toBe(200);
  });
});

describe("QA-11: a signed-in person of a workspace with no Semanto company is refused as another company's, not told to sign in", () => {
  it("answers 403 forbidden, and 401 only without a session", async () => {
    const w = await osWorld({ custody: "hosted" });
    const r = await get(w, "/acme/keys", "Bearer stranger-token");
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("forbidden");
    expect((await get(w, "/acme/keys", "Bearer nobody-token")).status).toBe(401);
  });
});

describe("QA-12: the session service down is a 503 to try again, never a 401 that reads as signed out", () => {
  it("answers 503 session_unavailable on the company routes and the claim routes", async () => {
    const w = await osWorld({ custody: "hosted" });
    const r = await get(w, "/acme/keys", "Bearer session-down");
    expect(r.status).toBe(503);
    const body = await json(r);
    expect(body.code).toBe("session_unavailable");
    expect(body.retryable).toBe(true);
    expect((await get(w, "/setup", "Bearer session-down")).status).toBe(503);
    expect((await get(w, "/acme/keys", "Bearer nobody-token")).status).toBe(401);
  });

  it("troothOsSession throws SessionUnavailable on a network error or a 5xx, and is null on a refusal", async () => {
    const req = new Request("https://api.trooth.co/os/semanto/x/keys", { headers: { authorization: "Bearer t" } });
    const service = (status: number | "throw") => ({ fetch: async () => { if (status === "throw") throw new Error("down"); return new Response("{}", { status }); } }) as unknown as Parameters<typeof troothOsSession>[0];
    await expect(troothOsSession(service("throw"))(req)).rejects.toBeInstanceOf(SessionUnavailable);
    await expect(troothOsSession(service(502))(req)).rejects.toBeInstanceOf(SessionUnavailable);
    expect(await troothOsSession(service(401))(req)).toBeNull();
  });
});

describe("QA-13: a build makes a credential job for each image and PDF its signed pages link on the company's site", () => {
  it("reads the markdown images and links, own site only, media only", () => {
    const md = "![Plant](https://acme.com/plant.jpg) [Manual](https://www.acme.com/docs/m.pdf#p2) ![Other](https://cdn.other.com/x.png) [Pricing](https://acme.com/pricing)";
    expect(pageMediaUrls(md, "acme.com")).toEqual(["https://acme.com/plant.jpg", "https://www.acme.com/docs/m.pdf"]);
  });

  it("records made for an image the site serves", async () => {
    const w = await osWorld({ custody: "hosted" });
    w.probes["https://acme.com/plant.jpg"] = { status: 200, headers: { "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
    await buildAndSign(w);
    const rows = (await json(await get(w, "/acme/credentials"))).rows as { asset_url: string; state: string }[];
    expect(rows.find((r) => r.asset_url === "https://acme.com/plant.jpg")?.state).toBe("made");
    expect(rows.every((r) => r.asset_url.startsWith("https://acme.com/"))).toBe(true);
  });
});

describe("dev upstream overrides (src/dev-upstream.ts): development only, loopback only", () => {
  it("is ignored in production and for a base that is not loopback http", () => {
    expect(devUpstreamBase({ ENVIRONMENT: "production", DEV_UPSTREAM_BASE: "http://127.0.0.1:9000" })).toBeNull();
    expect(devDashboardBase({ ENVIRONMENT: "production", DEV_DASHBOARD_BASE: "http://localhost:3000/dashboard/semanto" })).toBeNull();
    expect(devUpstreamBase({ ENVIRONMENT: "development", DEV_UPSTREAM_BASE: "https://evil.example" })).toBeNull();
    expect(devUpstreamBase({ ENVIRONMENT: "development", DEV_UPSTREAM_BASE: "http://user:pw@127.0.0.1:9000" })).toBeNull();
    expect(devUpstreamBase({ ENVIRONMENT: "development", DEV_UPSTREAM_BASE: "http://127.0.0.1:9000/" })).toBe("http://127.0.0.1:9000");
    expect(devDashboardBase({ ENVIRONMENT: "development", DEV_DASHBOARD_BASE: "http://localhost:3000/dashboard/semanto" })).toBe("http://localhost:3000/dashboard/semanto");
  });

  it("sends only the Google and Resend hosts to the stand-in, path and query kept", async () => {
    const seen: string[] = [];
    const f = devUpstreamFetch("http://127.0.0.1:9000", (async (input: RequestInfo | URL) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("{}");
    }) as typeof fetch);
    await f("https://oauth2.googleapis.com/token?x=1", { method: "POST" });
    await f("https://api.resend.com/emails");
    await f("https://acme.com/pricing");
    await f(new Request("https://merchantapi.googleapis.com/products/v1/accounts/1/productInputs:insert?dataSource=d"));
    expect(seen).toEqual(["http://127.0.0.1:9000/oauth2.googleapis.com/token?x=1", "http://127.0.0.1:9000/api.resend.com/emails", "https://acme.com/pricing", "http://127.0.0.1:9000/merchantapi.googleapis.com/products/v1/accounts/1/productInputs:insert?dataSource=d"]);
    expect(DEV_UPSTREAM_HOSTS.has("acme.com")).toBe(false);
  });

  it("without a base it is fetch itself", () => {
    const f = (async () => new Response("")) as unknown as typeof fetch;
    expect(devUpstreamFetch(null, f)).toBe(f);
  });
});
