// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: the Semanto setup guide and its four step pages (read, review and
// sign, put it on your site, watch), click by click as the owner, from a
// workspace with nothing set up to a signed, installed, monitored company.

import { load, shoot, see, control, d1, BASE } from "./lib.mjs";

export async function setupGuide(w, ctx) {
  const page = await w.newPage("owner", { passkey: true });
  ctx.ownerPage = page;

  // The guide: two shared steps done (sign-in, domain), Read is the open step.
  await load(w, page, "/dashboard/semanto", "guide-start");
  await see(w, page, "Setup guide");
  await see(w, page, "Read your website");
  await shoot(w, page, "guide-start", { keys: true });

  // Read: the guide's action opens the read page, which starts the read and shows it running, then done.
  w.step("read-start");
  await page.getByRole("link", { name: /See what was read/ }).click();
  await page.waitForURL(/\/dashboard\/semanto\/read$/);
  await page.waitForSelector("main h1");
  await shoot(w, page, "read-running");
  await page.getByText(/What Semanto read on/).first().waitFor({ timeout: 90_000 }).catch(() => w.note("the read never finished on screen"));
  await see(w, page, "Every page Semanto found was read.");
  await shoot(w, page, "read-done", { keys: true });
  const company = (await d1("SELECT trooth_id, domain, os_company_id FROM semanto_companies"))[0];
  ctx.troothId = company?.trooth_id;
  if (!ctx.troothId) w.note("no Semanto company row after the read");

  // Review and sign.
  w.step("review");
  await page.getByRole("link", { name: "Review and sign" }).or(page.getByRole("button", { name: "Review and sign" })).first().click();
  await page.waitForURL(/\/dashboard\/semanto\/sign$/);
  await page.getByText(/These are the facts Semanto found/).waitFor({ timeout: 30_000 }).catch(() => w.note("the review intro did not appear"));
  await page.getByText("Loading the facts").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await shoot(w, page, "review-facts", { keys: true });
  // Untick one fact: the fix-on-the-site guidance and the count appear; tick it again.
  const boxes = page.getByRole("checkbox", { name: "Looks right" });
  const n = await boxes.count();
  if (n === 0) w.note("no facts to review");
  else {
    await boxes.first().uncheck();
    await see(w, page, "a wrong fact is fixed on the page it came from");
    await see(w, page, /You marked 1 fact to fix/);
    await shoot(w, page, "review-one-marked");
    await boxes.first().check();
  }
  // Save for later goes back to the guide with the place kept; then come back.
  w.step("review-save-for-later");
  await page.getByRole("button", { name: "Save for later" }).click();
  await page.waitForURL(/\/dashboard\/semanto$/);
  await shoot(w, page, "guide-saved-for-later");
  await load(w, page, "/dashboard/semanto/sign", "review-again");
  await see(w, page, "Saved for later");
  w.step("review-confirm");
  await page.getByRole("button", { name: "Confirm these facts" }).click();
  await see(w, page, /You are signing version/);
  await see(w, page, "Add a signing passkey");
  await shoot(w, page, "sign-add-passkey", { keys: true });

  // The signing passkey, made on a virtual authenticator, then the signature.
  w.step("sign-add-passkey");
  await page.getByRole("button", { name: "Add a signing passkey" }).click();
  await page.getByRole("button", { name: "Sign with my passkey" }).waitFor({ timeout: 20_000 }).catch(() => w.note("Sign with my passkey did not appear after adding the passkey"));
  await shoot(w, page, "sign-ready");
  w.step("sign");
  await page.getByRole("button", { name: "Sign with my passkey" }).click();
  await page.getByText(/Signed by .* Trooth witnessed the signing/).waitFor({ timeout: 30_000 }).catch(() => w.note("no signed line after signing"));
  await shoot(w, page, "signed", { keys: true });
  const versions = await d1("SELECT version, signed_at FROM semanto_versions WHERE trooth_id = ? ORDER BY version", ctx.troothId).catch(() => []);
  ctx.signedVersion = versions.at(-1)?.version;

  // Put it on your site: the detected host, its guide, checks not passing until the site serves Semanto.
  w.step("install");
  await page.getByRole("link", { name: "Put it on your site" }).click();
  await page.waitForURL(/\/dashboard\/semanto\/install$/);
  await page.waitForSelector("main h1");
  await see(w, page, "Add Semanto to");
  await shoot(w, page, "install-guide", { keys: true });
  // Change host: the list opens, pick Vercel again (no change), it closes.
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByRole("list", { name: /Where your site runs/i }).waitFor({ timeout: 5_000 }).catch(() => w.note("the host list did not open"));
  await shoot(w, page, "install-host-list");
  await page.getByRole("button", { name: "Vercel" }).click();
  await page.waitForTimeout(800);
  w.step("install-check-before");
  await page.getByRole("button", { name: /Check my site|Check again/ }).click();
  await page.waitForTimeout(2500);
  await see(w, page, "Not yet");
  await shoot(w, page, "install-not-yet");
  // The merchant deploys the Vercel middleware (the repository's adapter now answers in front of the site), then checks again.
  await control("/install", { domain: ctx.domain, troothId: ctx.troothId });
  w.step("install-check-after");
  await page.getByRole("button", { name: /Check again|Check my site/ }).click();
  await page.waitForTimeout(3000);
  const passed = await page.getByText("Passed").count();
  if (passed < 3) w.note(`install checks: ${passed} of 3 passed after the adapter was installed`);
  await shoot(w, page, "install-passed", { keys: true });

  // Monitoring: questions and companies, invalid company first, then start.
  w.step("monitoring");
  // Ten questions are suggested, the most the list holds: one is removed, then one of our own is added.
  const removeQ = page.getByRole("button", { name: /^Remove the question / });
  if (await removeQ.count()) await removeQ.last().click();
  const qInput = page.getByLabel("New question");
  if (await qInput.count()) {
    await qInput.fill("Does Acme Goods ship to Canada?");
    await page.getByRole("button", { name: "Add a question" }).click();
  } else w.note("no New question field once checks passed");
  const name = page.getByLabel("Company name");
  if (await name.count()) {
    await name.fill("Initech");
    await page.getByRole("button", { name: "Add a company" }).click();
    await see(w, page, "Type the company name and its website");
    await shoot(w, page, "monitoring-company-invalid");
    await page.getByLabel(/website/i).last().fill("initech-qa.com");
    await page.getByRole("button", { name: "Add a company" }).click();
  }
  await shoot(w, page, "monitoring-ready", { keys: true });
  await page.getByRole("button", { name: "Start monitoring" }).click();
  await see(w, page, "serves your signed Semanto record");
  await shoot(w, page, "monitoring-started");
  w.step("watch");
  await page.getByRole("link", { name: "Open the report" }).click();
  await page.waitForURL(/\/dashboard\/semanto\/monitor$/);
  await page.waitForSelector("main h1");
  await page.waitForTimeout(1500);
  await shoot(w, page, "watch-report", { keys: true });
  await load(w, page, "/dashboard/semanto", "guide-done");
  await shoot(w, page, "guide-done", { keys: true });
}
