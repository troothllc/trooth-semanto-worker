// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Secrets at rest and the D1 session storage: sealed values open only with
// the same key and context; sessions round-trip through D1 with the access
// and refresh tokens never stored in the clear; retries back off and honour
// Retry-After.

import { describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-api";
import { FixtureD1 } from "./fixtures/d1";
import { SEAL_KEY } from "./fixtures/harness";
import { open, seal } from "../app/lib/seal";
import { D1SessionStorage } from "../app/lib/session-storage.server";
import { retryAfterMs, withRetry, RetryExhausted } from "../app/lib/retry";

describe("sealing", () => {
  it("round-trips, uses a fresh IV each time, and refuses another context or key", async () => {
    const a = await seal("secret value", "connector-key", SEAL_KEY);
    const b = await seal("secret value", "connector-key", SEAL_KEY);
    expect(a).not.toBe(b);
    expect(await open(a, "connector-key", SEAL_KEY)).toBe("secret value");
    await expect(open(a, "poll-token", SEAL_KEY)).rejects.toThrow();
    await expect(open(a, "connector-key", Buffer.from("another-fixture-key-32-bytes-ok!").toString("base64"))).rejects.toThrow();
  });

  it("refuses a seal key that is not 32 bytes", async () => {
    await expect(seal("x", "poll-token", Buffer.from("short").toString("base64"))).rejects.toThrow("32 bytes");
  });
});

describe("D1 session storage", () => {
  it("stores, loads, finds by shop and deletes sessions, sealed", async () => {
    const d1 = new FixtureD1();
    const s = new D1SessionStorage(d1.asD1(), SEAL_KEY);
    const session = new Session({ id: "offline_fixture-shop.myshopify.com", shop: "fixture-shop.myshopify.com", state: "", isOnline: false, scope: "read_products", accessToken: "shpat_fixture_secret", refreshToken: "shprt_fixture_secret", expires: new Date("2026-10-23T13:00:00Z"), refreshTokenExpires: new Date("2027-01-21T12:00:00Z") });
    expect(await s.storeSession(session)).toBe(true);
    const raw = await d1.prepare("SELECT * FROM shopify_sessions").first<{ sealed: string; shop: string; expires_at: string }>();
    expect(raw!.sealed).not.toContain("shpat_fixture_secret");
    expect(raw!.sealed).not.toContain("shprt_fixture_secret");
    expect(raw!.expires_at).toBe("2026-10-23T13:00:00.000Z");
    const loaded = (await s.loadSession(session.id))!;
    expect(loaded.accessToken).toBe("shpat_fixture_secret");
    expect(loaded.refreshToken).toBe("shprt_fixture_secret");
    expect(loaded.expires?.toISOString()).toBe("2026-10-23T13:00:00.000Z");
    expect(loaded.isOnline).toBe(false);
    expect((await s.findSessionsByShop("fixture-shop.myshopify.com")).map((x) => x.id)).toEqual([session.id]);
    await s.storeSession(new Session({ ...session.toObject(), accessToken: "shpat_fixture_rotated" }));
    expect((await s.loadSession(session.id))!.accessToken).toBe("shpat_fixture_rotated");
    expect(await s.deleteSessions([session.id])).toBe(true);
    expect(await s.loadSession(session.id)).toBeUndefined();
  });

  it("a row sealed with another key reads as no session, so Shopify's token exchange makes a new one", async () => {
    const d1 = new FixtureD1();
    const other = new D1SessionStorage(d1.asD1(), Buffer.from("another-fixture-key-32-bytes-ok!").toString("base64"));
    await other.storeSession(new Session({ id: "x", shop: "fixture-shop.myshopify.com", state: "", isOnline: false, accessToken: "t" }));
    expect(await new D1SessionStorage(d1.asD1(), SEAL_KEY).loadSession("x")).toBeUndefined();
  });
});

describe("retry with backoff", () => {
  it("retries 429 and 5xx, waits at least what Retry-After asks, and returns the first other answer", async () => {
    const waits: number[] = [];
    const answers = [new Response("", { status: 429, headers: { "retry-after": "3" } }), new Response("", { status: 502 }), new Response("ok", { status: 202 })];
    const res = await withRetry(async () => answers.shift()!, { sleep: async (ms) => void waits.push(ms), random: () => 0 });
    expect(res.status).toBe(202);
    expect(waits).toEqual([3000, 0]);
  });

  it("does not retry a 4xx other than 429", async () => {
    let n = 0;
    const res = await withRetry(async () => (n++, new Response("", { status: 401 })), { sleep: async () => undefined });
    expect([res.status, n]).toEqual([401, 1]);
  });

  it("gives up after the attempts with the last answer, or throws when every attempt failed to connect", async () => {
    const res = await withRetry(async () => new Response("", { status: 503 }), { sleep: async () => undefined, attempts: 3 });
    expect(res.status).toBe(503);
    await expect(
      withRetry(
        async () => {
          throw new TypeError("network down");
        },
        { sleep: async () => undefined, attempts: 2 },
      ),
    ).rejects.toBeInstanceOf(RetryExhausted);
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("Fri, 23 Oct 2026 12:00:10 GMT", Date.parse("2026-10-23T12:00:00Z"))).toBe(10000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});
