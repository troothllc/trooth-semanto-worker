// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 1b Signing key, domain binding and staged rotation. Hosted rotation
// started and cancelled (cancel confirm and its Cancel), started again and
// confirmed with the signing passkey, the old key revoked through the typed
// confirmation (wrong text, Cancel, then the key id), the DNS binding found
// once the record is published. keysCustomer: a customer-held rotation with
// the private key shown once (Copy, Download, Done) and confirmed.

import { load, shoot, see, control, d1, dialogFocus } from "./lib.mjs";
import { posts } from "./delivery.mjs";

const keysView = (ctx) => control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/keys`, headers: { authorization: "Bearer qa-token-owner-acme" } }).then((r) => JSON.parse(r.text));

export async function keys(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/keys", "keys");
  await see(w, page, "Your signing key signs each version of your record");
  await see(w, page, "This is your only signing key, so it cannot be revoked. Rotate first.");
  const onlyRevoke = page.getByRole("button", { name: /^Revoke key / });
  if ((await onlyRevoke.count()) !== 1 || (await onlyRevoke.first().isEnabled())) w.note("the only signing key's Revoke is not off");
  await see(w, page, "Not found");
  await shoot(w, page, "keys", { keys: true });

  // The binding: Check now before the record exists (Not found), then publish the TXT record and check again (Found).
  w.step("keys-binding");
  const view = await keysView(ctx);
  await page.getByRole("button", { name: "Check now" }).click();
  await page.waitForTimeout(1200);
  await see(w, page, "Not found");
  await control("/dns", { name: view.binding.dns_name, type: "TXT", values: [view.binding.dns_value] });
  await page.getByRole("button", { name: "Check now" }).click();
  await page.getByText("Found", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => w.note("the binding did not read Found after the TXT record was published"));
  await shoot(w, page, "keys-binding-found");

  // A hosted rotation, started then cancelled.
  w.step("keys-rotation-start");
  await page.getByRole("radio", { name: /Trooth keeps it/ }).check();
  await page.getByRole("button", { name: "Start rotation" }).dblclick();
  await see(w, page, "New key published");
  await see(w, page, "Published, not signing yet");
  await page.waitForTimeout(500);
  if (posts(w, /\/keys\/rotation\/start$/).length !== 1) w.note(`a double click on Start rotation sent ${posts(w, /\/keys\/rotation\/start$/).length} starts`);
  const started = await keysView(ctx);
  if (!started.rotation || started.rotation.state !== "started") w.note("no started rotation on the Worker after Start rotation");
  await shoot(w, page, "keys-rotation-started", { keys: true });

  w.step("keys-rotation-cancel");
  const cancelDlg = await dialogFocus(w, page, page.getByRole("button", { name: "Cancel rotation" }), "cancel rotation");
  await shoot(w, page, "keys-cancel-dialog");
  await cancelDlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(300);
  if (await page.getByRole("dialog").count()) w.note("Cancel did not close the cancel-rotation dialog");
  const focusBack = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (focusBack !== "Cancel rotation") w.note(`focus went to "${focusBack}" after closing the dialog, not back to Cancel rotation`);
  await page.getByRole("button", { name: "Cancel rotation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel rotation" }).click();
  await see(w, page, "The rotation was canceled.");
  await shoot(w, page, "keys-rotation-cancelled");
  const afterCancel = await keysView(ctx);
  if (!afterCancel.keys.some((k) => k.kid === started.rotation?.next_kid && k.state === "revoked")) w.note("the cancelled rotation's key is not revoked");

  // Started again and confirmed with the signing passkey.
  w.step("keys-rotation-confirm");
  await page.getByRole("radio", { name: /Trooth keeps it/ }).check();
  await page.getByRole("button", { name: "Start rotation" }).click();
  await see(w, page, "New key published");
  await page.getByRole("button", { name: /Confirm with my passkey|Add a signing passkey/ }).first().click();
  await see(w, page, "The new key signs from now on.");
  await see(w, page, "Overlap window: readers accept both the old and the new key");
  await shoot(w, page, "keys-rotation-confirmed", { keys: true });
  const confirmed = await keysView(ctx);
  const retiring = confirmed.keys.find((k) => k.state === "retiring");
  if (!retiring) w.note("no retiring key after the confirm");
  ctx.retiringKid = retiring?.kid;

  // Revoke the retiring key: the typed confirmation.
  w.step("keys-revoke");
  const revokeBtn = page.getByRole("button", { name: `Revoke key ${retiring?.kid}` });
  const dlg = await dialogFocus(w, page, revokeBtn, "revoke key");
  const action = dlg.getByRole("button", { name: "Revoke this key" });
  await dlg.getByRole("textbox").fill("not-the-key");
  if (await action.isEnabled()) w.note("Revoke this key is on while the typed text is wrong");
  await shoot(w, page, "keys-revoke-wrong-text");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  if (back !== `Revoke key ${retiring?.kid}`) w.note(`focus went to "${back}" after Cancel, not back to the Revoke button`);
  await revokeBtn.click();
  const dlg2 = page.getByRole("dialog");
  const box = dlg2.getByRole("textbox");
  if ((await box.inputValue()) !== "") w.note("the typed confirmation kept the earlier text after Cancel");
  await box.fill(retiring?.kid ?? "");
  await dlg2.getByRole("button", { name: "Revoke this key" }).dblclick();
  await see(w, page, `Key ${retiring?.kid} is revoked.`);
  await page.waitForTimeout(500);
  if (posts(w, /\/keys\/[^/]+\/revoke$/).length !== 1) w.note(`a double click on Revoke this key sent ${posts(w, /\/keys\/[^/]+\/revoke$/).length} revokes`);
  await shoot(w, page, "keys-revoked", { keys: true });
  const list = await control("/worker/fetch", { path: `/public/semanto/${ctx.troothId}/revocations` });
  if (!list.text.includes(retiring?.kid ?? "-")) w.note(`the revoked key is not on the public revocation list (${list.status})`);
}

/** A customer-held rotation: the browser makes the pair, the private key is shown once. */
export async function keysCustomer(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/keys", "keys-customer");
  w.step("keys-customer-start");
  await page.getByRole("radio", { name: /My company keeps it/ }).check();
  await page.getByRole("button", { name: "Start rotation" }).click();
  await see(w, page, "This is the only time this private key is shown");
  await shoot(w, page, "keys-customer-secret", { keys: true });
  // Copy puts the private JWK on the clipboard; Download saves the same JSON.
  await page.getByRole("button", { name: "Copy", exact: true }).first().click();
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  let jwk = null;
  try { jwk = JSON.parse(copied); } catch { w.note("the copied private key is not JSON"); }
  if (jwk && (!jwk.d || jwk.kty !== "OKP")) w.note("the copied private key is not an Ed25519 private JWK");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), page.getByRole("button", { name: "Download" }).click()]);
  const path = await download.path();
  const saved = path ? (await import("node:fs")).readFileSync(path, "utf8") : "";
  if (saved.trim() !== copied.trim()) w.note("the downloaded private key differs from the copied one");
  ctx.customerJwk = jwk;
  // Leaving while the key is on screen asks first.
  let asked = 0;
  const onDialog = async (d) => { asked += 1; await d.dismiss(); };
  page.on("dialog", onDialog);
  await page.locator("aside").getByRole("link", { name: "Home" }).first().click();
  await page.waitForTimeout(600);
  page.off("dialog", onDialog);
  if (!asked) w.note("leaving with the private key on screen did not ask");
  await page.getByRole("button", { name: "Done" }).click();
  if (await page.getByText("This is the only time this private key is shown").count()) w.note("Done did not remove the private key from the page");
  const inDom = await page.evaluate((d) => document.body.innerHTML.includes(d), jwk?.d ?? "-");
  if (inDom) w.note("the private key is still in the page after Done");

  w.step("keys-customer-confirm");
  await page.getByRole("button", { name: /Confirm with my passkey|Confirm the rotation/ }).first().click();
  await see(w, page, "The new key signs from now on.");
  await shoot(w, page, "keys-customer-confirmed");
  const v = await keysView(ctx);
  const active = v.keys.find((k) => k.state === "active");
  if (!active || active.custody !== "customer" || active.kid !== jwk?.kid) w.note("the customer key is not the signing key after the confirm");
  // No log line or answer carried the private half.
  const audit = await d1("SELECT before_hash, after_hash, target FROM semanto_audit WHERE trooth_id = ? ORDER BY at DESC LIMIT 5", ctx.troothId);
  if (JSON.stringify(audit).includes(jwk?.d ?? "-")) w.note("the private key is in the audit rows");
}

/** Two more customer-held rotations: the first customer key retires and its overlap is moved into the past (expired), the second is revoked. */
export async function keysOld(w, ctx) {
  const page = ctx.ownerPage;
  const first = ctx.customerJwk;
  await keysCustomer(w, ctx);
  const second = ctx.customerJwk;
  w.step("keys-expired");
  // The overlap window is 30 days; time is moved by setting the retiring key's exp in the Worker's row to yesterday.
  const rows = await d1("SELECT kid, public_jwk FROM semanto_keys WHERE kid = ?", first.kid);
  const jwk = JSON.parse(rows[0]?.public_jwk ?? "{}");
  jwk.exp = new Date(Date.now() - 86400_000).toISOString();
  await d1("UPDATE semanto_keys SET public_jwk = ?, exp = ? WHERE kid = ?", JSON.stringify(jwk), jwk.exp, first.kid);
  await load(w, page, "/dashboard/semanto/keys", "keys-expired");
  const v = await keysView(ctx);
  if (v.keys.find((k) => k.kid === first.kid)?.state !== "expired") w.note(`a retiring key past its overlap reads ${v.keys.find((k) => k.kid === first.kid)?.state}`);
  await see(w, page, "Retired");
  await shoot(w, page, "keys-expired", { keys: true });
  ctx.expiredJwk = first;
  await keysCustomer(w, ctx);
  w.step("keys-revoke-customer");
  await load(w, page, "/dashboard/semanto/keys", "keys-revoke-customer");
  await page.getByRole("button", { name: `Revoke key ${second.kid}` }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(second.kid);
  await page.getByRole("dialog").getByRole("button", { name: "Revoke this key" }).click();
  await see(w, page, `Key ${second.kid} is revoked.`);
  ctx.revokedJwk = second;
}
