// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: network failures. The Semanto Worker down (connections refused at
// the api front), slow past trooth-web's 15-second limit, and worker-f's
// session check down; for each, a read and a write, what the person sees, and
// Try again once it is back. (worker-f down for recall events is in recalls.mjs.)

import { load, shoot, see, control, BASE, STACK } from "./lib.mjs";

export async function outages(w, ctx) {
  const page = await w.newPage("owner", { passkey: true });
  const rejections = [];
  await page.exposeFunction("qaRejection", (m) => rejections.push(m));
  await page.addInitScript(() => window.addEventListener("unhandledrejection", (e) => window.qaRejection(String(e.reason?.message ?? e.reason))));

  // The Worker down: a read.
  w.step("outage-worker-down-read");
  await control("/mode", { front: "down" });
  await load(w, page, "/dashboard/semanto/keys", "outage-worker-down-read");
  await page.waitForTimeout(1500);
  await see(w, page, "Trooth could not be reached");
  if (await page.getByText("Semanto is not switched on for this workspace yet.").count()) w.note("a Worker outage reads as Semanto not switched on");
  await shoot(w, page, "outage-worker-down-read", { keys: true });
  await control("/mode", { front: "up" });
  await page.getByRole("button", { name: "Try again" }).first().click().catch(() => w.note("no Try again while the Worker was down"));
  await see(w, page, "Your signing key signs each version of your record");

  // The Worker down: a write.
  w.step("outage-worker-down-write");
  await load(w, page, "/dashboard/semanto/delivery", "outage-worker-down-write");
  await control("/mode", { front: "down" });
  await page.getByRole("checkbox", { name: /AI training/ }).check();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1500);
  await see(w, page, "Trooth could not be reached");
  if (await page.getByText("Saved. Readers get the new settings").count()) w.note("a save during an outage said Saved");
  await shoot(w, page, "outage-write-refused");
  await control("/mode", { front: "up" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await see(w, page, "Saved. Readers get the new settings from their next request.");
  await page.getByRole("checkbox", { name: /AI training/ }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await see(w, page, "Saved. Readers get the new settings from their next request.");

  // The Worker slow past the 15-second limit.
  w.step("outage-worker-slow");
  await control("/mode", { front: "slow" });
  const t0 = Date.now();
  await page.goto(`${BASE}/dashboard/semanto/connectors`);
  await page.getByText("Reading your connector keys").waitFor({ timeout: 10_000 }).catch(() => {});
  await page.getByText("Trooth could not be reached").first().waitFor({ timeout: 40_000 }).catch(() => w.note("a slow Worker never turned into the could-not-be-reached message"));
  const waited = Math.round((Date.now() - t0) / 1000);
  if (waited > 35) w.note(`a slow Worker took ${waited} seconds to say so`);
  await shoot(w, page, "outage-worker-slow");
  await control("/mode", { front: "up" });
  await page.getByRole("button", { name: "Try again" }).first().click().catch(() => {});
  await see(w, page, "Connector keys sign the catalog requests");

  // worker-f's session check down.
  w.step("outage-session-down");
  // worker-f down: trooth-web's own reads of it (the chrome) and Semanto's sign-in check answer 5xx; the screen says so.
  w.expect(502, /^\/api\/me$/);
  w.expect(503, /^\/api\/auth\/session$/);
  w.expect(503, /^\/api\/semanto\//);
  w.allowAbort = true;
  await control("/mode", { standin: "down" });
  await page.goto(`${BASE}/dashboard/semanto/company`);
  await page.waitForTimeout(4000);
  if (/\/signin/.test(page.url())) w.note("a session service outage sent the person to sign in");
  if (await page.getByRole("link", { name: /Sign in/ }).count() && !(await page.getByRole("button", { name: "Try again" }).count())) w.note("a session service outage offers only Sign in");
  await shoot(w, page, "outage-session-down");
  const direct = await fetch(`${BASE}/api/semanto/setup`, { headers: { cookie: `trooth_session=${STACK.personas.owner.token}` } });
  if (direct.status === 401) w.note("a session service outage answers 401 to a Semanto read");
  await control("/mode", { standin: "up" });
  w.allowAbort = false;
  await page.reload();
  await page.waitForSelector("main h1");
  await see(w, page, "Who must sign a new version");
  if (rejections.length) w.note(`unhandled promise rejections: ${rejections.join(" | ").slice(0, 300)}`);
}
