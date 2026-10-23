// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 2 Company settings. The signing policy to two officers and back (the
// typed confirmation), surfaces with every invalid field and a remove, the
// Merchant Center and Business Profile surfaces write-back sends to, alert
// addresses with the email captured at the Resend boundary and its link
// opened, the link opened again, Resend's wait, Remove, and Recent changes in
// words.

import { load, shoot, see, control, d1 } from "./lib.mjs";
import { posts } from "./delivery.mjs";

const company = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/company`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));

export async function companySettings(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/company", "company");
  await see(w, page, "Who must sign a new version");
  await see(w, page, "No alert addresses yet");
  await shoot(w, page, "company", { keys: true });

  // Signing policy: to two officers, then back with the typed confirmation.
  w.step("company-policy-two");
  const policy = page.locator("section", { has: page.getByRole("heading", { name: "Signing policy" }) });
  await policy.getByRole("radio", { name: /Two officers/ }).check();
  await policy.getByRole("button", { name: "Save signing policy" }).click();
  await see(w, page, "Saved. Each new version now needs two officers to sign.");
  w.step("company-policy-one");
  await policy.getByRole("radio", { name: /One officer/ }).check();
  await policy.getByRole("button", { name: "Save signing policy" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  await dlg.getByRole("textbox").fill("one");
  if (await dlg.getByRole("button", { name: "Change to one officer" }).isEnabled()) w.note("Change to one officer is on before the text matches");
  await shoot(w, page, "company-downgrade-dialog");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  if ((await company(ctx)).signing_policy.officers_required !== 2) w.note("Cancel on the downgrade changed the policy");
  await policy.getByRole("button", { name: "Save signing policy" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("one officer");
  await page.getByRole("dialog").getByRole("button", { name: "Change to one officer" }).click();
  await see(w, page, "Saved. One officer signs each new version from now on.");
  await shoot(w, page, "company-policy-one");

  // Surfaces: every invalid field, a valid marketplace, its removal.
  w.step("company-surface-invalid");
  const surf = page.locator("section", { has: page.getByRole("heading", { name: "Connected surfaces" }) });
  await surf.getByLabel("Kind").selectOption("marketplace");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Give this place a name.");
  await surf.getByLabel("Name").fill("y".repeat(121));
  await surf.getByLabel("Address (optional)").fill("http://www.amazon.com/stores/acme");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Keep the name to 120 characters or fewer.");
  await see(w, page, "Enter a full address that starts with https://.");
  await shoot(w, page, "company-surface-invalid");
  w.step("company-surface-add");
  await surf.getByLabel("Name").fill("Amazon store");
  await surf.getByLabel("Address (optional)").fill("https://www.amazon.com/stores/acme");
  await surf.getByRole("button", { name: "Add", exact: true }).dblclick();
  await see(w, page, "Amazon store is on the list.");
  await page.waitForTimeout(400);
  if (posts(w, /\/company\/surfaces$/).length !== 1) w.note(`a double click on Add sent ${posts(w, /\/company\/surfaces$/).length} surfaces`);
  w.step("company-surface-remove");
  await page.getByRole("button", { name: "Remove Amazon store" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Remove Amazon store" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove surface" }).click();
  await see(w, page, "Amazon store is off the list.");

  // The write-back targets: Merchant Center (account from Google, data source checked) and Business Profile.
  w.step("company-surface-merchant");
  await surf.getByLabel("Kind").selectOption("merchant_center");
  await surf.getByLabel("Name").fill("Acme Goods Store");
  const account = surf.getByLabel("Merchant Center account");
  // The field turns into a list once the Google accounts arrive; pick from the list when it is one.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  for (let i = 0; i < 2; i++) {
    try {
      if ((await account.evaluate((el) => el.tagName)) === "SELECT") await account.selectOption({ index: 1 });
      else await account.fill("accounts/123456");
      break;
    } catch (e) {
      if (i) throw e;
      await page.waitForTimeout(1500);
    }
  }
  await surf.getByLabel("Merchant API data source").fill("accounts/999/dataSources/42");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "The data source must belong to the account chosen.");
  await surf.getByLabel("Merchant API data source").fill("dataSources/42");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Enter the data source as accounts/ACCOUNT/dataSources/ID");
  await surf.getByLabel("Content language").fill("e1"); // the field holds two characters
  await surf.getByLabel("Feed label").fill("us market");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Use a two-letter language code, like en.");
  await see(w, page, "Use up to 20 capital letters, digits, dashes or underscores, like US.");
  await shoot(w, page, "company-merchant-invalid");
  await surf.getByLabel("Merchant API data source").fill("accounts/123456/dataSources/42");
  await surf.getByLabel("Content language").fill("en");
  await surf.getByLabel("Feed label").fill("US");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Acme Goods Store is on the list.");
  w.step("company-surface-business");
  await surf.getByLabel("Kind").selectOption("business_profile");
  await surf.getByLabel("Name").fill("Acme Goods, Main Street");
  const loc = surf.getByLabel("Business Profile location");
  if ((await loc.evaluate((el) => el.tagName)) === "SELECT") await loc.selectOption({ index: 1 });
  else await loc.fill("locations/555");
  await surf.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Acme Goods, Main Street is on the list.");
  await shoot(w, page, "company-surfaces", { keys: true });

  // Alert addresses: an invalid address, a valid one (double clicked: one email), the link from the email.
  w.step("company-alert-invalid");
  const alerts = page.locator("section", { has: page.getByRole("heading", { name: "Alert addresses" }) });
  await alerts.getByLabel("Add an address").fill("not an address");
  await alerts.getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Enter one email address, like name@company.com.");
  w.step("company-alert-add");
  const before = (await control("/emails")).length;
  await alerts.getByLabel("Add an address").fill("alerts@acmegoods-qa.com");
  w.expect(409, /\/company\/alerts$/);
  await alerts.getByRole("button", { name: "Add", exact: true }).dblclick();
  await see(w, page, "Trooth emailed alerts@acmegoods-qa.com a link to confirm it.");
  await page.waitForTimeout(800);
  const mails = (await control("/emails")).slice(before);
  if (mails.length !== 1) w.note(`adding one address sent ${mails.length} emails`);
  await see(w, page, "Pending");
  await see(w, page, /Resend at/);
  await shoot(w, page, "company-alert-pending", { keys: true });
  const text = mails[0]?.message?.text ?? "";
  const link = /(https?:\/\/\S+\/public\/semanto\/alerts\/confirm\?token=[A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (!link) w.note(`no confirmation link in the email: ${text.slice(0, 300)}`);
  if (mails[0] && !mails[0].authorization_present) w.note("the email was sent without the Resend key");
  w.step("company-alert-confirm");
  await page.goto(link);
  await page.waitForURL(/\/dashboard\/semanto\/company\?alerts=confirmed/, { timeout: 15_000 }).catch(() => w.note(`the confirmation link landed on ${page.url()}`));
  await page.waitForSelector("main h1");
  await see(w, page, "The alert address is confirmed. Alerts go to it from now on.");
  await see(w, page, "Confirmed");
  await shoot(w, page, "company-alert-confirmed", { keys: true });
  // The same link again: used.
  w.step("company-alert-link-used");
  await page.goto(link);
  await page.waitForURL(/alerts=error/, { timeout: 15_000 }).catch(() => {});
  await page.waitForSelector("main h1");
  await see(w, page, "That confirmation link does not work any more.");
  await shoot(w, page, "company-alert-link-used");

  // A second address: Resend waits a minute; then Remove.
  w.step("company-alert-second");
  await load(w, page, "/dashboard/semanto/company", "company-alert-second");
  await page.locator("section", { has: page.getByRole("heading", { name: "Alert addresses" }) }).getByLabel("Add an address").fill("ops@acmegoods-qa.com");
  await page.locator("section", { has: page.getByRole("heading", { name: "Alert addresses" }) }).getByRole("button", { name: "Add", exact: true }).click();
  await see(w, page, "Trooth emailed ops@acmegoods-qa.com");
  const resend = page.getByRole("button", { name: /^Resend.* the confirmation link to ops@acmegoods-qa\.com$/ });
  if (await resend.isEnabled()) w.note("Resend is on less than a minute after the link went out");
  w.step("company-alert-remove");
  await page.getByRole("button", { name: "Remove ops@acmegoods-qa.com" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove address" }).click();
  await see(w, page, "ops@acmegoods-qa.com is off the list and gets no more alerts.");

  // Recent changes: words for every action, no raw ids.
  w.step("company-recent-changes");
  await load(w, page, "/dashboard/semanto/company", "company-recent");
  const recent = await page.locator("section", { has: page.getByRole("heading", { name: "Recent changes" }) }).innerText();
  for (const raw of ["settings.save", "keys.rotation", "connectors.", "company.", "google.", "made a change"]) if (recent.includes(raw)) w.note(`Recent changes shows "${raw}"`);
  if (/Request [a-f0-9]{8,}/.test(recent) === false) w.note("Recent changes rows carry no request id");
  await shoot(w, page, "company-recent", { keys: true });
  const c = await company(ctx);
  if (!c.alert_addresses.some((a) => a.address === "alerts@acmegoods-qa.com" && a.state === "confirmed")) w.note("the confirmed address is not confirmed on the Worker");
  ctx.alertAddress = "alerts@acmegoods-qa.com";
}
