// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The onboarding state machine, pure, shared by the server and the screens.
//
// Screen order, modeled on the best-reviewed apps in the catalog and
// structured-data category (submission/screenshots.md and the program report
// list them): Welcome (what the app does, in plain words), Connect to Trooth
// (Klaviyo's connect step: the account is approved on the service's own site,
// then the app shows it connected), Turn on the app embed (Klaviyo's and the
// JSON-LD apps' "Turn on" button that opens the theme editor on the App embeds
// tab, then the status turns on), First sync (Klaviyo's "Historical data"
// progress, with a status per step), Done (a link to the Semanto dashboard).
//
// The connection itself is the device-flow pattern (GitHub device flow,
// Stripe CLI login): the app makes an Ed25519 key for the shop, Trooth makes a
// session, the merchant approves it on trooth.co in a new window, and the app
// checks the session every two seconds, only while the merchant is on the
// Connect screen, and never after the session expires. Every transition below
// names the effects the server must carry out, so an abandoned connection
// (window closed, session expired, request denied, app uninstalled half way)
// always ends with the pending key removed: nothing is left behind.

import type { EmbedState, SyncRunRow } from "./store.server";

export type Step = "welcome" | "connect" | "embed" | "sync" | "done";
export const STEPS: Step[] = ["welcome", "connect", "embed", "sync", "done"];

export type Connection =
  | { state: "none"; reason: "denied" | "expired" | "disconnected" | null }
  | { state: "pending"; sessionId: string; approveUrl: string; expiresAt: string }
  | { state: "connected"; troothId: string; kid: string; connectedAt: string };

export type SyncView =
  | { state: "never" }
  | { state: "running"; run: SyncRunRow }
  | { state: "done"; run: SyncRunRow }
  | { state: "failed"; run: SyncRunRow };

export interface OnboardingInput {
  welcomeDone: boolean;
  connection: Connection;
  embed: EmbedState;
  sync: SyncView;
}

/** The screen a merchant should see now. Earlier screens stay reachable; this is where Continue leads. */
export function currentStep(s: OnboardingInput): Step {
  if (!s.welcomeDone && s.connection.state !== "connected") return "welcome";
  if (s.connection.state !== "connected") return "connect";
  if (s.embed !== "active" && s.embed !== "skipped") return "embed";
  if (s.sync.state !== "done") return "sync";
  return "done";
}

/** Each step's status for the step list at the top of the onboarding card. */
export function stepStatuses(s: OnboardingInput): Record<Step, "complete" | "current" | "upcoming"> {
  const cur = STEPS.indexOf(currentStep(s));
  return Object.fromEntries(STEPS.map((st, i) => [st, i < cur ? "complete" : i === cur ? "current" : "upcoming"])) as Record<Step, "complete" | "current" | "upcoming">;
}

// ---------------------------------------------------------------- the connection

export type ConnectEvent =
  | { type: "connect_clicked" }
  | { type: "session_created"; sessionId: string; approveUrl: string; expiresAt: string }
  | { type: "poll"; result: { state: "pending" } | { state: "approved"; trooth_id: string; kid: string } | { state: "denied" } | { state: "expired" } }
  | { type: "disconnect" }
  | { type: "uninstall" };

export type Effect =
  /** Make the shop's key, store it sealed, start a Trooth connect session with its public half. */
  | "create_session"
  /** Open the approve address again (the pending session is still good). */
  | "open_approve_window"
  /** Delete the pending key and session locally; Trooth never registered the key. */
  | "discard_pending"
  /** Store the Trooth ID, write the embed values, start the first sync. */
  | "finalize"
  /** Ask Trooth to revoke the key (signed with it), then delete it locally. */
  | "revoke_key"
  /** Remove the embed values from the app installation. */
  | "clear_embed_values"
  /** Delete every row the app holds for the shop. */
  | "delete_shop_data";

export interface Transition {
  next: Connection;
  effects: Effect[];
}

const expired = (expiresAt: string, now: Date) => now.getTime() >= Date.parse(expiresAt);

export function connectTransition(c: Connection, e: ConnectEvent, now: Date): Transition {
  switch (e.type) {
    case "connect_clicked":
      if (c.state === "connected") return { next: c, effects: [] };
      if (c.state === "pending" && !expired(c.expiresAt, now)) return { next: c, effects: ["open_approve_window"] };
      if (c.state === "pending") return { next: { state: "none", reason: "expired" }, effects: ["discard_pending", "create_session"] };
      return { next: c, effects: ["create_session"] };
    case "session_created":
      if (c.state === "connected") return { next: c, effects: ["discard_pending"] };
      return { next: { state: "pending", sessionId: e.sessionId, approveUrl: e.approveUrl, expiresAt: e.expiresAt }, effects: [] };
    case "poll": {
      if (c.state !== "pending") return { next: c, effects: [] };
      const r = e.result;
      // Approval wins even when it lands in the last second: Trooth has registered the key, so the app must use it, not orphan it.
      if (r.state === "approved") return { next: { state: "connected", troothId: r.trooth_id, kid: r.kid, connectedAt: now.toISOString() }, effects: ["finalize"] };
      if (r.state === "denied") return { next: { state: "none", reason: "denied" }, effects: ["discard_pending"] };
      if (r.state === "expired" || expired(c.expiresAt, now)) return { next: { state: "none", reason: "expired" }, effects: ["discard_pending"] };
      return { next: c, effects: [] };
    }
    case "disconnect":
      if (c.state === "connected") return { next: { state: "none", reason: "disconnected" }, effects: ["revoke_key", "clear_embed_values"] };
      if (c.state === "pending") return { next: { state: "none", reason: null }, effects: ["revoke_key"] };
      return { next: c, effects: [] };
    case "uninstall":
      // The app's access token is already gone on uninstall, so the embed values cannot be cleared; the embed itself is removed by Shopify with the app.
      return { next: { state: "none", reason: null }, effects: c.state === "none" ? ["delete_shop_data"] : ["revoke_key", "delete_shop_data"] };
  }
}

/** The client's polling rule: every two seconds while pending, on this screen, and before the session expires; otherwise stop. */
export const POLL_INTERVAL_MS = 2000;
export function nextPollDelay(c: Connection, now: Date, onConnectScreen: boolean): number | null {
  if (!onConnectScreen || c.state !== "pending") return null;
  const left = Date.parse(c.expiresAt) - now.getTime();
  if (left <= 0) return null;
  return Math.min(POLL_INTERVAL_MS, left);
}

// ---------------------------------------------------------------- the embed

/** The theme editor deep link that opens the App embeds tab with Semanto's embed selected (shopify.dev, theme app extensions, configuration). */
export function embedDeepLink(shop: string, apiKey: string, blockHandle: string): string {
  return `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(apiKey)}/${encodeURIComponent(blockHandle)}`;
}

/** What App Bridge's app.extensions() says about the embed, reduced to the app's embed state. */
export function embedStateFrom(extensions: { type: string; activations: { handle: string; status: string; target?: string }[] }[], blockHandle: string): EmbedState {
  for (const ext of extensions) {
    if (ext.type !== "theme_app_extension") continue;
    const a = ext.activations.find((x) => x.handle === blockHandle);
    if (a) return a.status === "active" ? "active" : "inactive";
  }
  return "inactive";
}
