// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 3 Write-back that sends. Preview, pick, Review, Back, Send (double
// clicked: one run), per-item states moving to sent through the queue
// consumer and the Google stand-in; Google turning a change away (400) and a
// retry; 429 and 500 retried by the queue after 30 seconds; a refused token
// refresh (invalid_grant) marking the connection needs_reconnect with exactly
// one alert email and the Reconnect path; the history list.

import { load, shoot, see, control, d1 } from "./lib.mjs";
import { posts } from "./delivery.mjs";

const runs = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/writeback/runs`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));
const run = (ctx, id) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/writeback/runs/${id}`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));

async function waitRun(ctx, id, done, tries = 40) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = await run(ctx, id);
    if (done(r)) return r;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return r;
}

/** The run a send just made: the newest run whose id was not on the list before the send. */
async function newRunId(ctx, before) {
  for (let i = 0; i < 40; i++) {
    const id = (await runs(ctx)).runs?.find((r) => !before.has(r.run_id))?.run_id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return null;
}
const runIds = async (ctx) => new Set(((await runs(ctx)).runs ?? []).map((r) => r.run_id));

async function pickAndSend(w, page, count, label) {
  const boxes = page.locator("form ul input[type=checkbox]");
  const n = await boxes.count();
  if (n < count) w.note(`${label}: ${n} changes to pick, wanted ${count}`);
  for (let i = 0; i < Math.min(count, n); i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: /^Review \d+ change/ }).click();
  await page.getByRole("button", { name: /^Send \d+ change/ }).waitFor();
}

export async function writeback(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await control("/mode", { writes: [], refresh: "ok" });
  await load(w, page, "/dashboard/semanto/writeback", "writeback");
  await page.getByText("Working out what would change").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await see(w, page, /proposed change/);
  await shoot(w, page, "writeback", { keys: true });
  // The files to put in place: each downloads.
  w.step("writeback-files");
  const dls = page.getByRole("button", { name: /^Download the .* file$/ });
  for (let i = 0; i < (await dls.count()); i++) {
    const [d] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), dls.nth(i).click()]);
    if (!d.suggestedFilename()) w.note("a write-back file downloaded with no name");
  }

  // Pick two, Review, Back keeps the picks, Send (double click: one run).
  w.step("writeback-send");
  await pickAndSend(w, page, 2, "first send");
  await shoot(w, page, "writeback-review", { keys: true });
  await page.getByRole("button", { name: "Back" }).click();
  if ((await page.locator("form ul input[type=checkbox]:checked").count()) !== 2) w.note("Back from Review lost the picks");
  await page.getByRole("button", { name: /^Review \d+ change/ }).click();
  await page.getByRole("button", { name: /^Send \d+ change/ }).dblclick();
  await see(w, page, /being sent to Google/);
  await page.waitForTimeout(600);
  if (posts(w, /\/writeback\/send$/).length !== 1) w.note(`a double click on Send sent ${posts(w, /\/writeback\/send$/).length} sends`);
  const first = (await runs(ctx)).runs?.[0]; // the only run so far
  const settled = await waitRun(ctx, first?.run_id, (r) => r.items?.every((i) => i.state === "sent" || i.state === "failed"));
  if (!settled?.items?.every((i) => i.state === "sent")) w.note(`the first run did not settle as sent: ${JSON.stringify(settled?.items?.map((i) => [i.state, i.last_error]))}`);
  await page.getByText("All sent").first().waitFor({ timeout: 20_000 }).catch(() => {});
  await see(w, page, /2 sent, 0 failed, 0 waiting/);
  await shoot(w, page, "writeback-run-sent", { keys: true });
  const sentToGoogle = (await control("/upstream")).calls.filter((c) => /productInputs:insert|\/v1\/locations\//.test(c.path));
  if (sentToGoogle.length < 2) w.note(`Google received ${sentToGoogle.length} writes for the first run`);

  // Google turns a change away (400): failed with Google's words; Retry the failed change sends it again.
  w.step("writeback-400");
  await control("/mode", { writes: [400] });
  await page.getByRole("button", { name: "Back to proposed changes" }).click();
  await pickAndSend(w, page, 1, "400 send");
  const before400 = await runIds(ctx);
  await page.getByRole("button", { name: /^Send \d+ change/ }).click();
  const r400 = await waitRun(ctx, await newRunId(ctx, before400), (r) => r.items?.every((i) => i.state === "failed" || i.state === "sent"));
  if (r400?.items?.[0]?.state !== "failed") w.note(`a 400 from Google left the item ${r400?.items?.[0]?.state}`);
  await see(w, page, /The price is not valid for the feed label/);
  await shoot(w, page, "writeback-failed-400", { keys: true });
  await page.getByRole("button", { name: "Retry the failed change" }).dblclick();
  await see(w, page, /queued again/);
  const retried = await waitRun(ctx, r400.run_id, (r) => r.items?.every((i) => i.state === "sent"));
  if (!retried?.items?.every((i) => i.state === "sent")) w.note("the retried change did not send");
  if (posts(w, /\/writeback\/runs\/[^/]+\/retry$/).length !== 1) w.note(`a double click on Retry sent ${posts(w, /\/writeback\/runs\/[^/]+\/retry$/).length} retries`);

  // 429 and 500: retried by the queue after its delay, then sent.
  w.step("writeback-429-500");
  await control("/mode", { writes: [429, 500] });
  await page.getByRole("button", { name: "Back to proposed changes" }).click();
  await pickAndSend(w, page, 2, "429 send");
  const before429 = await runIds(ctx);
  await page.getByRole("button", { name: /^Send \d+ change/ }).click();
  const id429 = await newRunId(ctx, before429);
  const retrying = await waitRun(ctx, id429, (r) => r.items?.some((i) => i.state === "retrying"), 20);
  if (!retrying?.items?.some((i) => i.state === "retrying")) w.note("a 429 did not show the item as retrying");
  await see(w, page, "Retrying");
  await shoot(w, page, "writeback-retrying");
  const after = await waitRun(ctx, id429, (r) => r.items?.every((i) => i.state === "sent"), 60);
  if (!after?.items?.every((i) => i.state === "sent")) w.note(`after 429 and 500 the items are ${JSON.stringify(after?.items?.map((i) => i.state))}`);

  // invalid_grant: Google answers 401 to a write, the refresh is refused; needs_reconnect, one alert, Reconnect.
  w.step("writeback-invalid-grant");
  const mailsBefore = (await control("/emails")).length;
  await control("/mode", { writes: [401, 401], refresh: "invalid_grant" });
  await page.getByRole("button", { name: "Back to proposed changes" }).click();
  await pickAndSend(w, page, 2, "invalid_grant send");
  const beforeG = await runIds(ctx);
  await page.getByRole("button", { name: /^Send \d+ change/ }).click();
  const idg = await newRunId(ctx, beforeG);
  const rg = await waitRun(ctx, idg, (r) => r.items?.every((i) => i.state === "failed"), 30);
  if (!rg?.items?.every((i) => i.state === "failed")) w.note(`after invalid_grant the items are ${JSON.stringify(rg?.items?.map((i) => [i.state, i.last_error]))}`);
  await see(w, page, "Reconnect Google");
  await shoot(w, page, "writeback-needs-reconnect", { keys: true });
  const mails = (await control("/emails")).slice(mailsBefore);
  const reconnectMails = mails.filter((m) => /Reconnect Google/.test(m.message?.subject ?? ""));
  if (reconnectMails.length !== 1) w.note(`invalid_grant sent ${reconnectMails.length} reconnect alerts`);
  if (reconnectMails[0] && JSON.stringify(reconnectMails[0].message.to) !== JSON.stringify([ctx.alertAddress])) w.note(`the reconnect alert went to ${JSON.stringify(reconnectMails[0].message.to)}`);
  const link = /(https?:\/\/\S+\/connections)/.exec(reconnectMails[0]?.message?.text ?? "")?.[1];
  // The Google screen says so; Reconnect from the failed item goes there.
  await page.getByRole("link", { name: "Reconnect Google" }).first().click();
  await page.waitForURL(/\/dashboard\/semanto\/connections/);
  await see(w, page, "Needs reconnecting");
  await see(w, page, "Google stopped accepting Trooth's stored permission");
  await shoot(w, page, "google-needs-reconnect", { keys: true });
  if (link && !link.startsWith("http://localhost:")) w.note(`the alert's link is ${link}`);
  w.step("writeback-reconnect");
  await control("/mode", { refresh: "ok", writes: [] });
  await page.getByRole("button", { name: "Reconnect Google" }).last().click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/google=connected/, { timeout: 20_000 }).catch(() => w.note("Reconnect did not come back connected"));
  await see(w, page, "Google is connected.");
  // Retry the failed items of that run from History.
  await load(w, page, "/dashboard/semanto/writeback", "writeback-history");
  await see(w, page, "History");
  await shoot(w, page, "writeback-history", { keys: true });
  const open = page.getByRole("button", { name: /^View run of / }).first();
  await open.click();
  await page.getByRole("button", { name: /Retry all \d+ failed|Retry the failed change/ }).click();
  const healed = await waitRun(ctx, idg, (r) => r.items?.every((i) => i.state === "sent"), 30);
  if (!healed?.items?.every((i) => i.state === "sent")) w.note("after Reconnect the retried items did not send");
  const mailsAfter = (await control("/emails")).slice(mailsBefore).filter((m) => /Reconnect Google/.test(m.message?.subject ?? ""));
  if (mailsAfter.length !== 1) w.note(`by the end, ${mailsAfter.length} reconnect alerts went out`);
  const tokens = JSON.stringify(await d1("SELECT * FROM semanto_writeback_items"));
  if (/ya29\.qa-|1\/\/qa-refresh-/.test(tokens)) w.note("a Google token is stored with the write-back items");
}
