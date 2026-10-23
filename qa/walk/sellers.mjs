// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 4 Seller lists. sellersHosted: the form with every invalid field, the
// paste import (bad columns, then good), Remove seller, Sign and publish with
// the signing passkey, a second version superseding the first, the public list
// and a seller check. sellersCustomer (after the customer-held rotation): the
// upload with every malformed file, another company's list, a version not
// newer, a bad signature (422, nothing stored), a list signed with an expired
// key and with a revoked key, and a good upload.

import { writeFileSync, mkdirSync } from "node:fs";
import { load, shoot, see, control, d1, STACK } from "./lib.mjs";
import { posts } from "./delivery.mjs";
import { compactJws, freshJwk, TYPES } from "./jws.mjs";

const lists = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/sellers/lists`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));

async function fillSeller(page, n, v) {
  const fs = page.locator("fieldset", { has: page.locator("legend", { hasText: `Seller ${n}` }) });
  for (const [label, value] of Object.entries(v)) await fs.getByLabel(label, { exact: true }).fill(value);
}

export async function sellersHosted(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/sellers", "sellers-empty");
  await see(w, page, "No seller list yet");
  await shoot(w, page, "sellers-empty", { keys: true });

  // Every invalid field, named beside it.
  w.step("sellers-invalid");
  await page.getByRole("radio", { name: /Build the list here/ }).check();
  await page.getByRole("button", { name: /^Sign and publish version 1$/ }).click();
  await see(w, page, "This is needed.");
  await see(w, page, "Fix the fields marked above, then sign.");
  await fillSeller(page, 1, { "Seller ID": "S-1", Name: "Kettle Outlet", "Domain (optional)": "https://kettle-outlet.com", "Authorized from": "2026-10-01", "Authorized until (optional)": "2026-09-01" });
  await page.getByRole("button", { name: /^Sign and publish version 1$/ }).click();
  await see(w, page, "Enter a domain like shop.example.com, without https://.");
  await see(w, page, "The end date is before the start date.");
  await page.getByRole("button", { name: "Add a seller" }).click();
  await fillSeller(page, 2, { "Seller ID": "S-1", Name: "Duplicate", "Authorized from": "2026-10-01" });
  await page.getByRole("button", { name: /^Sign and publish version 1$/ }).click();
  await see(w, page, "Another seller on this list has the same ID.");
  await see(w, page, "Give a domain or a marketplace, so the seller can be found.");
  await shoot(w, page, "sellers-invalid", { keys: true });
  await page.getByRole("button", { name: "Remove seller 2" }).click();
  await fillSeller(page, 1, { "Domain (optional)": "kettle-outlet.com", "Authorized until (optional)": "" });

  // The paste import: a wrong header, then two good rows.
  w.step("sellers-paste");
  const paste = page.getByLabel("Paste sellers");
  await paste.fill("seller_id,name,website\nX,Y,shop.com");
  await page.getByRole("button", { name: "Add these sellers" }).click();
  await see(w, page, "The first line names a column Trooth does not take.");
  await paste.fill("seller_id,name,domain,marketplace,authorized_from,authorized_until\nS-2,Tea House,teahouse-shop.com,,2026-10-01,\nS-3,Amazon reseller,,Amazon,2026-10-05,2027-10-05");
  await page.getByRole("button", { name: "Add these sellers" }).click();
  await see(w, page, "Added 2 sellers.");
  await shoot(w, page, "sellers-built");

  // Sign and publish with the signing passkey (double clicked: one publish).
  w.step("sellers-sign");
  await page.getByRole("button", { name: /^Sign and publish version 1$/ }).dblclick();
  await see(w, page, "Version 1 of your seller list is published.");
  await page.waitForTimeout(500);
  if (posts(w, /\/sellers\/lists$/).length !== 1) w.note(`a double click on Sign and publish sent ${posts(w, /\/sellers\/lists$/).length} lists`);
  await shoot(w, page, "sellers-published", { keys: true });
  const pubList = await control("/worker/fetch", { path: `/public/semanto/${ctx.troothId}/sellers` });
  const pl = JSON.parse(pubList.text);
  if (pl.version !== 1 || pl.sellers?.length !== 3) w.note(`the public seller list answers ${pubList.text.slice(0, 200)}`);
  const check = JSON.parse((await control("/worker/fetch", { path: `/public/semanto/${ctx.troothId}/sellers?domain=teahouse-shop.com` })).text);
  if (check.state !== "authorized") w.note(`the seller check for a listed domain answers ${check.state}`);
  const no = JSON.parse((await control("/worker/fetch", { path: `/public/semanto/${ctx.troothId}/sellers?domain=fake-kettles.com` })).text);
  if (no.state !== "not_listed") w.note(`the seller check for an unlisted domain answers ${no.state}`);

  // Version 2 supersedes version 1.
  w.step("sellers-v2");
  await load(w, page, "/dashboard/semanto/sellers", "sellers-v2");
  await see(w, page, "New version 2");
  await page.getByRole("radio", { name: /Build the list here/ }).check();
  await fillSeller(page, 1, { "Seller ID": "S-9", Name: "Kettle Outlet", "Domain (optional)": "kettle-outlet.com", "Authorized from": "2026-10-01" });
  await page.getByRole("button", { name: /^Sign and publish version 2$/ }).click();
  await see(w, page, "Version 2 of your seller list is published.");
  await see(w, page, "Superseded");
  await shoot(w, page, "sellers-v2", { keys: true });
}

export async function sellersCustomer(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  const dir = `${w.out}/files`;
  mkdirSync(dir, { recursive: true });
  const file = (name, text) => { const p = `${dir}/${name}`; writeFileSync(p, text); return p; };
  const draft = (version, extra = {}) => ({ trooth_id: ctx.troothId, version, issued_at: new Date().toISOString(), sellers: [{ seller_id: "S-20", name: "Kettle Outlet", domain: "kettle-outlet.com", authorized_from: "2026-10-01T00:00:00Z" }], ...extra });
  await load(w, page, "/dashboard/semanto/sellers", "sellers-customer");
  await see(w, page, "Your company keeps its own key, so Trooth cannot sign for you.");
  await page.getByRole("radio", { name: /Upload a list my company signed/ }).check();
  const input = page.getByLabel("Signed list file");
  const cases = [
    ["empty.jws", "", "The file is empty."],
    ["two-parts.jws", "abc.def", "This is not a compact JWS."],
    ["bad-header.jws", "!!!.abc.def", "This is not a compact JWS."],
    ["header-garbage.jws", `${Buffer.from("not json").toString("base64url")}.e30.c2ln`, "The first part of the file is not a JWS header Trooth can read."],
    ["es256.jws", `${Buffer.from(JSON.stringify({ alg: "ES256", kid: "k" })).toString("base64url")}.e30.c2ln`, "The file is not signed with an Ed25519 key (alg EdDSA)."],
    ["other-company.jws", compactJws(draft(3, { trooth_id: "someone-else" }), ctx.customerJwk, TYPES.sellerList), "This list is for another company."],
    ["not-newer.jws", compactJws(draft(2), ctx.customerJwk, TYPES.sellerList), "This is version 2, and version 2 is already on file."],
  ];
  w.step("sellers-upload-invalid");
  for (const [name, text, words] of cases) {
    await input.setInputFiles(file(name, text));
    await see(w, page, words);
  }
  await shoot(w, page, "sellers-upload-invalid", { keys: true });
  // A bad signature: signed by a key the company never had. The Worker answers 422 and stores nothing.
  w.step("sellers-upload-bad-signature");
  const stranger = freshJwk();
  await input.setInputFiles(file("stranger.jws", compactJws(draft(3), { ...stranger, kid: ctx.customerJwk.kid }, TYPES.sellerList)));
  w.expect(422, /\/sellers\/lists$/);
  await page.getByRole("button", { name: /^Publish (this list|version 3)$/ }).click();
  await see(w, page, "The signature did not check out against your company's key");
  await shoot(w, page, "sellers-bad-signature", { keys: true });
  if ((await lists(ctx)).lists.some((l) => l.version === 3)) w.note("a list with a bad signature was stored");
  // A good upload.
  w.step("sellers-upload-good");
  await input.setInputFiles(file("good.jws", compactJws(draft(3), ctx.customerJwk, TYPES.sellerList)));
  await see(w, page, /is a compact JWS signed with key/);
  await page.getByRole("button", { name: /^Publish (this list|version 3)$/ }).click();
  await see(w, page, "Version 3 of your seller list is published.");
  await shoot(w, page, "sellers-uploaded");
}

/** After a second customer rotation: a list signed with the retired key (expired) and with a revoked key is refused. */
export async function sellersOldKeys(w, ctx) {
  const page = ctx.ownerPage;
  const dir = `${w.out}/files`;
  const file = (name, text) => { const p = `${dir}/${name}`; writeFileSync(p, text); return p; };
  const draft = (version) => ({ trooth_id: ctx.troothId, version, issued_at: new Date().toISOString(), sellers: [{ seller_id: "S-30", name: "Kettle Outlet", domain: "kettle-outlet.com", authorized_from: "2026-10-01T00:00:00Z" }] });
  await load(w, page, "/dashboard/semanto/sellers", "sellers-old-keys");
  await page.getByRole("radio", { name: /Upload a list my company signed/ }).check();
  w.step("sellers-expired-key");
  await page.getByLabel("Signed list file").setInputFiles(file("expired.jws", compactJws(draft(4), ctx.expiredJwk, TYPES.sellerList)));
  w.expect(422, /\/sellers\/lists$/);
  await page.getByRole("button", { name: /^Publish (this list|version 4)$/ }).click();
  await see(w, page, "The signature did not check out against your company's key");
  w.step("sellers-revoked-key");
  await load(w, page, "/dashboard/semanto/sellers", "sellers-revoked-key");
  await page.getByRole("radio", { name: /Upload a list my company signed/ }).check();
  await page.getByLabel("Signed list file").setInputFiles(file("revoked.jws", compactJws(draft(4), ctx.revokedJwk, TYPES.sellerList)));
  w.expect(422, /\/sellers\/lists$/);
  await page.getByRole("button", { name: /^Publish (this list|version 4)$/ }).click();
  await see(w, page, "The signature did not check out against your company's key");
  await shoot(w, page, "sellers-revoked-key");
  if ((await lists(ctx)).lists.some((l) => l.version === 4)) w.note("a list signed with an expired or revoked key was stored");
}
