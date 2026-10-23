// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The onboarding state machine: the screen order, the connection transitions
// and their effects (every way a connection can end leaves no pending key),
// the polling rule (every two seconds, only on the Connect screen, never after
// expiry), the embed deep link and the embed state from App Bridge.

import { describe, expect, it } from "vitest";
import type { SyncRunRow } from "../app/lib/store.server";
import { connectTransition, currentStep, embedDeepLink, embedStateFrom, nextPollDelay, stepStatuses, type Connection, type OnboardingInput } from "../app/lib/onboarding";

const NOW = new Date("2026-10-23T12:00:00Z");
const pending: Connection = { state: "pending", sessionId: "cs_1", approveUrl: "https://trooth.co/dashboard/semanto/connect/cs_1", expiresAt: "2026-10-23T12:15:00Z" };
const connectedC: Connection = { state: "connected", troothId: "fixture-co", kid: "kid1", connectedAt: NOW.toISOString() };
const none: Connection = { state: "none", reason: null };
const run: SyncRunRow = { id: "r", shop: "s", kind: "first", state: "done", bulk_operation_id: null, steps: [], products: 0, records: 0, offers: 0, skipped: 0, signed: true, error: null, started_at: "", finished_at: "" };

const input = (o: Partial<OnboardingInput>): OnboardingInput => ({ welcomeDone: false, connection: none, embed: "unknown", sync: { state: "never" }, ...o });

describe("screen order", () => {
  it("goes Welcome, Connect, Turn on the app embed, First sync, Done", () => {
    expect(currentStep(input({}))).toBe("welcome");
    expect(currentStep(input({ welcomeDone: true }))).toBe("connect");
    expect(currentStep(input({ welcomeDone: true, connection: pending }))).toBe("connect");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC }))).toBe("embed");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC, embed: "inactive" }))).toBe("embed");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC, embed: "active" }))).toBe("sync");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC, embed: "skipped", sync: { state: "running", run: { ...run, state: "running" } } }))).toBe("sync");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC, embed: "active", sync: { state: "failed", run: { ...run, state: "failed" } } }))).toBe("sync");
    expect(currentStep(input({ welcomeDone: true, connection: connectedC, embed: "active", sync: { state: "done", run } }))).toBe("done");
  });

  it("a store connected before the welcome was seen skips the welcome", () => {
    expect(currentStep(input({ connection: connectedC }))).toBe("embed");
  });

  it("marks earlier steps complete and later ones upcoming", () => {
    expect(stepStatuses(input({ welcomeDone: true, connection: connectedC }))).toEqual({ welcome: "complete", connect: "complete", embed: "current", sync: "upcoming", done: "upcoming" });
  });
});

describe("connection transitions", () => {
  it("Connect from nothing creates a session; Connect while pending reopens the same session", () => {
    expect(connectTransition(none, { type: "connect_clicked" }, NOW).effects).toEqual(["create_session"]);
    expect(connectTransition(pending, { type: "connect_clicked" }, NOW)).toEqual({ next: pending, effects: ["open_approve_window"] });
  });

  it("Connect on an expired pending session discards it before making a new one", () => {
    expect(connectTransition(pending, { type: "connect_clicked" }, new Date("2026-10-23T12:15:00Z")).effects).toEqual(["discard_pending", "create_session"]);
  });

  it("Connect when already connected does nothing", () => {
    expect(connectTransition(connectedC, { type: "connect_clicked" }, NOW).effects).toEqual([]);
  });

  it("approval finalizes; denial and expiry discard the pending key", () => {
    const ok = connectTransition(pending, { type: "poll", result: { state: "approved", trooth_id: "fixture-co", kid: "kid1" } }, NOW);
    expect(ok.next.state).toBe("connected");
    expect(ok.effects).toEqual(["finalize"]);
    expect(connectTransition(pending, { type: "poll", result: { state: "denied" } }, NOW)).toEqual({ next: { state: "none", reason: "denied" }, effects: ["discard_pending"] });
    expect(connectTransition(pending, { type: "poll", result: { state: "expired" } }, NOW)).toEqual({ next: { state: "none", reason: "expired" }, effects: ["discard_pending"] });
  });

  it("a pending answer after the local expiry still discards; an approval landing at the last second is kept", () => {
    const late = new Date("2026-10-23T12:15:01Z");
    expect(connectTransition(pending, { type: "poll", result: { state: "pending" } }, late).effects).toEqual(["discard_pending"]);
    expect(connectTransition(pending, { type: "poll", result: { state: "approved", trooth_id: "fixture-co", kid: "kid1" } }, late).effects).toEqual(["finalize"]);
    expect(connectTransition(pending, { type: "poll", result: { state: "pending" } }, NOW)).toEqual({ next: pending, effects: [] });
  });

  it("Disconnect revokes and clears the embed values; uninstall revokes and deletes everything, from any state", () => {
    expect(connectTransition(connectedC, { type: "disconnect" }, NOW).effects).toEqual(["revoke_key", "clear_embed_values"]);
    expect(connectTransition(pending, { type: "disconnect" }, NOW).effects).toEqual(["revoke_key"]);
    expect(connectTransition(none, { type: "disconnect" }, NOW).effects).toEqual([]);
    expect(connectTransition(connectedC, { type: "uninstall" }, NOW).effects).toEqual(["revoke_key", "delete_shop_data"]);
    expect(connectTransition(pending, { type: "uninstall" }, NOW).effects).toEqual(["revoke_key", "delete_shop_data"]);
    expect(connectTransition(none, { type: "uninstall" }, NOW).effects).toEqual(["delete_shop_data"]);
  });

  it("every path out of pending other than approval removes the key", () => {
    const exits = [
      connectTransition(pending, { type: "poll", result: { state: "denied" } }, NOW),
      connectTransition(pending, { type: "poll", result: { state: "expired" } }, NOW),
      connectTransition(pending, { type: "connect_clicked" }, new Date("2026-10-23T13:00:00Z")),
      connectTransition(pending, { type: "disconnect" }, NOW),
      connectTransition(pending, { type: "uninstall" }, NOW),
    ];
    for (const t of exits) expect(t.effects.some((e) => e === "discard_pending" || e === "revoke_key")).toBe(true);
  });
});

describe("polling rule", () => {
  it("every two seconds while pending on the Connect screen", () => {
    expect(nextPollDelay(pending, NOW, true)).toBe(2000);
  });
  it("never off the Connect screen, never when not pending, never after expiry", () => {
    expect(nextPollDelay(pending, NOW, false)).toBeNull();
    expect(nextPollDelay(connectedC, NOW, true)).toBeNull();
    expect(nextPollDelay(none, NOW, true)).toBeNull();
    expect(nextPollDelay(pending, new Date("2026-10-23T12:15:00Z"), true)).toBeNull();
  });
  it("the last wait is shortened to the expiry", () => {
    expect(nextPollDelay(pending, new Date("2026-10-23T12:14:59.500Z"), true)).toBe(500);
  });
});

describe("app embed", () => {
  it("deep links to the theme editor's App embeds tab with activateAppId = client id / block handle", () => {
    expect(embedDeepLink("fixture-shop.myshopify.com", "abc123", "trooth-head")).toBe("https://fixture-shop.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=abc123/trooth-head");
  });
  it("reads the embed's state from App Bridge's app.extensions()", () => {
    const ext = (status: string) => [{ type: "theme_app_extension", activations: [{ handle: "trooth-head", status, target: "head" }] }];
    expect(embedStateFrom(ext("active"), "trooth-head")).toBe("active");
    expect(embedStateFrom(ext("available"), "trooth-head")).toBe("inactive");
    expect(embedStateFrom(ext("unavailable"), "trooth-head")).toBe("inactive");
    expect(embedStateFrom([], "trooth-head")).toBe("inactive");
  });
});
