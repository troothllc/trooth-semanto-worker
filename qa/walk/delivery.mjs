// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 1a Delivery settings. Invalid combinations, the preview before Save,
// Discard, Save (a double click sends once), Ctrl+S, the leave guard, and the
// audit row Save writes.

import { load, shoot, see, d1 } from "./lib.mjs";

export const posts = (w, re) => w.requests.filter((r) => r.method === "POST" && re.test(r.path));

export async function delivery(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/delivery", "delivery");
  await see(w, page, "Every reader of the same page gets the same bytes");
  await see(w, page, /Trooth saw .*Looked|Trooth has not looked at your host yet/);
  await shoot(w, page, "delivery", { keys: true });

  // Invalid: markdown off while Semanto is the markdown source. The rule shows, Save is off, the preview waits.
  w.step("delivery-invalid");
  const md = page.getByRole("checkbox", { name: /Markdown for each page/ });
  await md.uncheck();
  await see(w, page, "Markdown is off, so Semanto cannot be the markdown source");
  await see(w, page, "Unsaved changes");
  await see(w, page, "Fix the problems above to see what this change does.");
  const saveBtn = page.getByRole("button", { name: "Save changes" });
  if (await saveBtn.isEnabled()) w.note("Save is enabled while the settings break a rule");
  await shoot(w, page, "delivery-invalid", { keys: true });
  w.step("delivery-discard");
  await page.getByRole("button", { name: "Discard" }).click();
  if (!(await md.isChecked())) w.note("Discard did not put markdown back on");
  if (await page.getByText("Unsaved changes").count()) w.note("the unsaved bar stayed after Discard");

  // A converter source needs Cloudflare: the option is off on Vercel; choosing Cloudflare turns it on.
  w.step("delivery-host");
  const then = page.getByRole("radio", { name: /Semanto first, Cloudflare for the rest/ });
  if (await then.isEnabled()) w.note("the Cloudflare converter option is on while the host is not Cloudflare");
  await page.getByLabel("Host", { exact: true }).selectOption("cloudflare");
  await see(w, page, "A host adapter runs only when your own domain is on");
  await page.getByRole("checkbox", { name: /On your own domain/ }).check();
  await then.check();
  await page.getByText("After you save").first().waitFor({ timeout: 10_000 }).catch(() => w.note("no preview effects after a valid change"));
  await shoot(w, page, "delivery-preview", { keys: true });
  // The save bar in the viewport: its buttons must not sit under anything else fixed on the page.
  await page.screenshot({ path: `${w.out}/delivery-savebar-viewport.png` });
  const covered = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Save changes");
    if (!b) return "no button";
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (top === b || b.contains(top)) ? null : (top?.closest("[data-setup-launcher]") ? "the setup guide launcher" : top?.outerHTML.slice(0, 120));
  });
  if (covered) w.note(`Save changes is covered by ${covered}`);

  // Save, double clicked: one POST settings, the success line, the audit row.
  w.step("delivery-save");
  const before = posts(w, /\/api\/semanto\/[^/]+\/settings$/).length;
  await saveBtn.dblclick();
  await see(w, page, "Saved. Readers get the new settings from their next request.");
  await page.waitForTimeout(800);
  const sent = posts(w, /\/api\/semanto\/[^/]+\/settings$/).length - before;
  if (sent !== 1) w.note(`a double click on Save sent ${sent} saves`);
  await shoot(w, page, "delivery-saved");
  const audit = await d1("SELECT action FROM semanto_audit WHERE trooth_id = ? AND action = 'settings.save'", ctx.troothId);
  if (!audit.length) w.note("no settings.save audit row after Save");

  // Ctrl+S saves, as the profile editor does.
  w.step("delivery-ctrl-s");
  await page.getByRole("checkbox", { name: /AI training/ }).check();
  await page.keyboard.press("Control+s");
  await see(w, page, "Saved. Readers get the new settings from their next request.");

  // The leave guard: a change, then a link out; the browser asks; Cancel stays.
  w.step("delivery-leave-guard");
  await page.getByRole("checkbox", { name: /AI training/ }).uncheck();
  let asked = 0;
  const onDialog = async (d) => { asked += 1; await d.dismiss(); };
  page.on("dialog", onDialog);
  await page.locator("aside").getByRole("link", { name: "Home" }).first().click();
  await page.waitForTimeout(800);
  page.off("dialog", onDialog);
  if (!asked) w.note("leaving with unsaved changes did not ask");
  if (!/\/dashboard\/semanto\/delivery/.test(page.url())) w.note("Cancel on the leave question still left the page");
  await page.getByRole("button", { name: "Discard" }).click();

  // Put the host back for the rest of the walk.
  w.step("delivery-restore");
  await page.getByRole("radio", { name: /Semanto's markdown only/ }).check();
  await page.getByLabel("Host", { exact: true }).selectOption("vercel");
  await page.getByRole("checkbox", { name: /AI training/ }).uncheck().catch(() => {});
  await page.getByRole("button", { name: "Save changes" }).click();
  await see(w, page, "Saved. Readers get the new settings from their next request.");
}
