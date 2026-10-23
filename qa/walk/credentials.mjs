// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 6 Content credentials status. The rows the build's queue jobs made
// (an image, a PDF, an image the site does not serve), the state filter in
// the address with Back, and View credential opening the signed manifest.

import { load, shoot, see, control, d1 } from "./lib.mjs";

export async function credentials(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  const rows = await d1("SELECT asset_url, state, reason FROM semanto_credentials WHERE trooth_id = ?", ctx.troothId);
  if (!rows.some((r) => r.state === "made")) w.note(`no credential was made for the site's image and PDF: ${JSON.stringify(rows).slice(0, 300)}`);
  await load(w, page, "/dashboard/semanto/credentials", "credentials");
  await page.getByRole("table").waitFor({ timeout: 15_000 }).catch(() => w.note("no credentials table"));
  await shoot(w, page, "credentials", { keys: true });
  w.step("credentials-filter");
  const failed = page.getByRole("button", { name: /^Failed \(\d+\)$/ });
  if (await failed.count()) {
    await failed.click();
    await page.waitForTimeout(800);
    if (!/state=failed/.test(page.url())) w.note("the state filter is not in the address");
    await shoot(w, page, "credentials-failed");
    await page.goBack();
    await page.waitForTimeout(800);
    if (/state=failed/.test(page.url())) w.note("Back did not undo the filter");
  }
  w.step("credentials-empty-state");
  await page.getByRole("button", { name: /^Skipped \(\d+\)$/ }).click().catch(() => {});
  await page.waitForTimeout(600);
  w.step("credentials-view");
  await page.getByRole("button", { name: /^All \(\d+\)$/ }).click().catch(() => {});
  const view = page.getByRole("link", { name: /^View credential/ }).first();
  await view.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await view.count()) {
    const href = await view.getAttribute("href");
    const r = await fetch(href);
    const body = await r.json().catch(() => null);
    if (r.status !== 200 || body?.object !== "semanto.c2pa_manifest") w.note(`View credential answers ${r.status} ${JSON.stringify(body).slice(0, 160)}`);
    if (!r.headers.get("signature")) w.note("the public manifest is not signed");
  } else w.note("no View credential link for a made credential");
}
