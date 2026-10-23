// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 1e Connect Google. Nothing picked, Cancel on Google's page, a partial
// grant, the full connect, a reused and a stale callback, Disconnect with its
// Cancel and confirm (revoked at Google), and Connect again for write-back.
// Google's consent page is the upstream double's stand-in (qa/doubles.mjs),
// reached because the browser's request for accounts.google.com is routed there.

import { load, shoot, see, control, d1, STACK } from "./lib.mjs";

const googleView = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/google`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));

async function connectThrough(w, page, { allow = true, uncheck = [] } = {}) {
  await page.getByRole("button", { name: /^(Connect Google|Reconnect Google|Change permissions)$/ }).last().click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 15_000 }).catch(() => w.note("Connect Google did not open Google's consent page"));
  await shoot(w, page, `google-consent-${allow ? "allow" : "cancel"}`, { axe: false });
  for (const s of uncheck) await page.getByRole("checkbox", { name: s }).uncheck();
  await page.getByRole("button", { name: allow ? "Allow" : "Cancel" }).click();
  await page.waitForURL(/\/dashboard\/semanto\/connections\?google=/, { timeout: 20_000 }).catch(() => w.note(`Google's page did not return to the dashboard (at ${page.url()})`));
  await page.waitForSelector("main h1");
  await page.waitForTimeout(800);
}

export async function google(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/connections", "google-not-connected");
  await see(w, page, "No Google account connected");
  await shoot(w, page, "google-not-connected", { keys: true });

  // Nothing picked: Connect is off and says so.
  w.step("google-pick-none");
  await page.getByRole("checkbox", { name: /Merchant Center/ }).uncheck();
  await page.getByRole("checkbox", { name: /Business Profile/ }).uncheck();
  await see(w, page, "Choose at least one.");
  const connectBtn = page.getByRole("button", { name: "Connect Google" }).last();
  if (await connectBtn.isEnabled()) w.note("Connect Google is on with nothing picked");
  await shoot(w, page, "google-pick-none");
  await page.getByRole("checkbox", { name: /Merchant Center/ }).check();
  await page.getByRole("checkbox", { name: /Business Profile/ }).check();

  // Cancel on Google's page.
  w.step("google-cancel");
  await connectThrough(w, page, { allow: false });
  await see(w, page, "You chose not to allow access on Google's page");
  await shoot(w, page, "google-cancelled", { keys: true });

  // Google grants only one of the two: declined scopes are said.
  w.step("google-partial");
  await connectThrough(w, page, { uncheck: ["https://www.googleapis.com/auth/business.manage"] });
  await see(w, page, "Google is connected.");
  await see(w, page, "Not granted");
  await shoot(w, page, "google-partial");

  // The full connect (Change permissions asks Google again for both).
  w.step("google-connect");
  // After the partial grant the form holds what was granted; Business Profile is ticked again to ask for it.
  await page.getByRole("checkbox", { name: /Business Profile/ }).check();
  await connectThrough(w, page);
  await see(w, page, "Google is connected.");
  await see(w, page, "merchant@acmegoods-qa.com");
  await see(w, page, "Merchant Center account 123456");
  await see(w, page, "Acme Goods, Main Street");
  await shoot(w, page, "google-connected", { keys: true });
  const g = await googleView(ctx);
  if (g.state !== "connected" || g.scopes.some((s) => !s.granted)) w.note(`the Worker's Google view after the full connect: ${JSON.stringify(g).slice(0, 300)}`);
  const sealed = await d1("SELECT * FROM semanto_google_connections WHERE trooth_id = ?", ctx.troothId);
  if (/1\/\/qa-refresh-/.test(JSON.stringify(sealed))) w.note("the Google refresh token is stored in the clear");
  if (/1\/\/qa-refresh-|ya29\.qa-/.test(JSON.stringify(await d1("SELECT * FROM semanto_audit WHERE trooth_id = ?", ctx.troothId)))) w.note("a Google token is in the audit rows");

  // A callback used twice, and one started more than 10 minutes ago.
  w.step("google-callback-reused");
  const calls = (await control("/upstream")).calls.filter((c) => c.path === "/token");
  if (!calls.length) w.note("no token exchange reached the Google stand-in");
  const st = await control("/worker/fetch", { method: "POST", path: `/os/semanto/${ctx.troothId}/google/connect`, headers: { authorization: "Bearer qa-token-owner-acme", "content-type": "application/json" }, body: { products: ["merchant"] } });
  const state = new URL(JSON.parse(st.text).authorization_url).searchParams.get("state");
  await page.goto(`${STACK.api}/public/semanto/google/callback?state=${encodeURIComponent(state)}&code=qa-code-not-issued`);
  await page.waitForURL(/google=error/, { timeout: 10_000 }).catch(() => {});
  await see(w, page, "Google is not connected: Google did not finish the connection");
  await page.goto(`${STACK.api}/public/semanto/google/callback?state=${encodeURIComponent(state)}&code=again`);
  await page.waitForURL(/google=error/, { timeout: 10_000 }).catch(() => {});
  await see(w, page, "The connection took longer than 10 minutes, or was started in another tab");
  await shoot(w, page, "google-state-invalid");
  const st2 = await control("/worker/fetch", { method: "POST", path: `/os/semanto/${ctx.troothId}/google/connect`, headers: { authorization: "Bearer qa-token-owner-acme", "content-type": "application/json" }, body: { products: ["merchant"] } });
  const state2 = new URL(JSON.parse(st2.text).authorization_url).searchParams.get("state");
  await d1("UPDATE semanto_google_states SET expires_at = ? WHERE trooth_id = ? AND expires_at > ?", new Date(Date.now() - 1000).toISOString(), ctx.troothId, new Date().toISOString());
  await page.goto(`${STACK.api}/public/semanto/google/callback?state=${encodeURIComponent(state2)}&code=late`);
  await page.waitForURL(/google=error/, { timeout: 10_000 }).catch(() => {});
  await see(w, page, "The connection took longer than 10 minutes");
  const still = await googleView(ctx);
  if (still.state !== "connected") w.note("a failed callback changed the existing connection");

  // Disconnect: Cancel keeps it; confirm revokes at Google.
  w.step("google-disconnect");
  await load(w, page, "/dashboard/semanto/connections", "google-disconnect");
  await page.getByRole("button", { name: "Disconnect" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  await shoot(w, page, "google-disconnect-dialog");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  if ((await googleView(ctx)).state !== "connected") w.note("Cancel on the disconnect question disconnected");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Disconnect/ }).click();
  await see(w, page, "Google is disconnected.");
  await shoot(w, page, "google-disconnected", { keys: true });
  if (!(await control("/upstream")).revoked.length) w.note("Disconnect did not revoke the token at Google");
  if ((await d1("SELECT trooth_id FROM semanto_google_connections WHERE trooth_id = ?", ctx.troothId)).length) w.note("Disconnect left the sealed token in D1");

  // Connect again, for write-back.
  w.step("google-reconnect");
  await connectThrough(w, page);
  await see(w, page, "Google is connected.");
}
