// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 1d Connector keys. Paste with every invalid key the form names, a
// valid key, its duplicate; Create with the private key shown once; Test
// connection before and after a real signed catalog request (and after a bad
// signature); an edge key answered by the repository's adapter; Revoke through
// the typed confirmation; a revoked key and an expired key refused by the
// catalog route.

import { load, shoot, see, control, d1, dialogFocus, STACK } from "./lib.mjs";
import { posts } from "./delivery.mjs";

const sign = await import(new URL("../../adapters/shared/sign-request.mjs", import.meta.url).href);

/** A real catalog request to the Worker, signed with a connector key as the adapters sign it. */
export async function sendCatalog(troothId, privateJwk, { tamper = false, products } = {}) {
  const url = `${STACK.semanto}/os/semanto/${troothId}/commerce/catalog`;
  const body = JSON.stringify({ trooth_id: troothId, source: "qa-connector", currency: "USD", products: products ?? [{ sku: "KET-001", name: "Classic Kettle", url: `https://${STACK.companies.acme.domain}/products/kettle`, gtin: "00012345678905", price: "49.00", stock_status: "instock" }] });
  const headers = await sign.signPost({ url, body, privateJwk });
  if (tamper) headers.Signature = headers.Signature.replace(/:(.)/, (m, c) => `:${c === "A" ? "B" : "A"}`);
  const r = await fetch(url, { method: "POST", headers: { ...headers, "cf-connecting-ip": "198.51.100.30" }, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function connectors(w, ctx) {
  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/connectors", "connectors-empty");
  await see(w, page, "No connector keys yet");
  await shoot(w, page, "connectors-empty", { keys: true });

  // Paste: every invalid key is named beside the field.
  w.step("connectors-paste-invalid");
  const pasteDlg = await dialogFocus(w, page, page.getByRole("button", { name: "Paste a public key" }).first(), "paste a key");
  await pasteDlg.getByRole("button", { name: "Add key" }).click();
  await see(w, page, "Give the key a name so your team knows what uses it.");
  await see(w, page, "Paste the public key first.");
  await shoot(w, page, "connectors-paste-empty");
  const field = pasteDlg.getByLabel("Public key (JWK)");
  const name = pasteDlg.getByLabel("Name");
  await name.fill("x".repeat(101));
  await pasteDlg.getByRole("button", { name: "Add key" }).click();
  // The field holds at most 100 characters; the form takes 80, under the Worker's 100.
  await see(w, page, /Keep the name to \d+ characters or fewer/);
  const cases = [
    ["{not json", "This is not JSON."],
    ['[{"kty":"OKP"}]', "This is JSON, but not one key."],
    ['{"kty":"RSA","n":"abc","e":"AQAB"}', "This is not an Ed25519 key."],
    ['{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","d":"nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"}', "This key has a private part"],
    ['{"kty":"OKP","crv":"Ed25519","x":"short"}', 'The "x"'],
  ];
  for (const [value, words] of cases) {
    await field.fill(value);
    await field.blur();
    await see(w, page, words);
  }
  await shoot(w, page, "connectors-paste-invalid");
  // A valid public key, made here; its private half signs the catalog requests below.
  const pasted = await sign.generateConnectorKey();
  ctx.pastedConnector = pasted;
  w.step("connectors-paste");
  await name.fill("QA order system");
  await field.fill(JSON.stringify(pasted.publicJwk));
  await field.blur();
  await see(w, page, "This is an Ed25519 public key.");
  await pasteDlg.getByLabel("What signs with it").selectOption("api").catch(() => pasteDlg.getByRole("radio", { name: /own system/ }).check());
  await pasteDlg.getByRole("button", { name: "Add key" }).dblclick();
  await see(w, page, "QA order system is added.");
  await page.waitForTimeout(500);
  if (posts(w, /\/connectors$/).length !== 1) w.note(`a double click on Add key sent ${posts(w, /\/connectors$/).length} adds`);
  await shoot(w, page, "connectors-pasted", { keys: true });
  // The same key again: named as a duplicate before anything is sent.
  w.step("connectors-duplicate");
  await page.getByRole("button", { name: "Paste a public key" }).first().click();
  const again = page.getByRole("dialog");
  await again.getByLabel("Name").fill("Same key");
  await again.getByLabel("Public key (JWK)").fill(JSON.stringify(pasted.publicJwk));
  await again.getByLabel("Public key (JWK)").blur();
  await see(w, page, "A key with this kid is already on the list.");
  await again.getByRole("button", { name: "Cancel" }).click();

  // Create: Trooth makes the pair and shows the private half once.
  w.step("connectors-create");
  const createDlg = await dialogFocus(w, page, page.getByRole("button", { name: "Create a key" }).first(), "create a key");
  await createDlg.getByLabel("Name").fill("Vercel middleware on www");
  await createDlg.getByLabel("What signs with it").selectOption("edge").catch(() => createDlg.getByRole("radio", { name: /adapter on my site/ }).check());
  await createDlg.getByRole("button", { name: /^Create/ }).last().click();
  await see(w, page, "Vercel middleware on www is ready");
  await shoot(w, page, "connectors-created-secret");
  await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
  const created = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  if (!created.d) w.note("the created connector key's private half was not copied");
  ctx.edgeConnector = created;
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  const leftInPage = await page.evaluate((d) => document.body.innerHTML.includes(d), created.d ?? "-");
  if (leftInPage) w.note("the created private key is still in the page after Done");
  const stored = await d1("SELECT * FROM semanto_connector_keys WHERE kid = ?", created.kid);
  if (JSON.stringify(stored).includes(created.d)) w.note("the created private key is stored");

  // Test connection: never seen, then connected after a signed catalog request, then a bad signature.
  w.step("connectors-test");
  const testPasted = page.getByRole("button", { name: "Test connection of QA order system" });
  await testPasted.click();
  await see(w, page, "Not seen yet");
  await shoot(w, page, "connectors-test-never-seen");
  const ok = await sendCatalog(ctx.troothId, pasted.privateJwk);
  if (ok.status < 200 || ok.status > 299) w.note(`a catalog request signed with the pasted key answered ${ok.status}: ${JSON.stringify(ok.body).slice(0, 200)}`);
  await testPasted.click();
  await see(w, page, "Connected");
  await shoot(w, page, "connectors-test-connected");
  const bad = await sendCatalog(ctx.troothId, pasted.privateJwk, { tamper: true });
  if (bad.status !== 401) w.note(`a tampered signature answered ${bad.status}`);
  await testPasted.click();
  await see(w, page, "Signature did not check out");
  await shoot(w, page, "connectors-test-signature-failed");
  await sendCatalog(ctx.troothId, pasted.privateJwk);

  // The edge key: the repository's adapter in front of the site holds it and answers its kid.
  w.step("connectors-edge");
  await control("/install", { domain: ctx.domain, troothId: ctx.troothId, connectorKey: created });
  await page.getByRole("button", { name: "Test connection of Vercel middleware on www" }).click();
  await see(w, page, "answers with this key");
  await shoot(w, page, "connectors-test-edge");

  // An expired key: pasted with an exp in the past, its requests are refused.
  w.step("connectors-expired");
  const old = await sign.generateConnectorKey();
  const pastedOld = await control("/worker/fetch", { method: "POST", path: `/os/semanto/${ctx.troothId}/connectors`, headers: { authorization: "Bearer qa-token-owner-acme", "content-type": "application/json" }, body: { public_jwk: { ...old.publicJwk, nbf: "2026-01-01T00:00:00Z", exp: "2026-02-01T00:00:00Z" }, label: "Expired key", source: "api" } });
  if (pastedOld.status !== 201 && pastedOld.status !== 200) w.note(`pasting a key with a past exp answered ${pastedOld.status}`);
  const expired = await sendCatalog(ctx.troothId, old.privateJwk);
  if (expired.status !== 401) w.note(`a catalog request signed with an expired key answered ${expired.status}`);

  // Revoke the pasted key: the typed confirmation, then its requests are refused.
  w.step("connectors-revoke");
  const revokeBtn = page.getByRole("button", { name: "Revoke QA order system" });
  const dlg = await dialogFocus(w, page, revokeBtn, "revoke connector");
  await dlg.getByRole("textbox").fill("wrong");
  if (await dlg.getByRole("button", { name: "Revoke this key" }).isEnabled()) w.note("Revoke this key is on while the typed text is wrong");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(300);
  if ((await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Revoke QA order system") w.note("focus did not return to Revoke after Cancel");
  await revokeBtn.click();
  await page.getByRole("dialog").getByRole("textbox").fill(pasted.publicJwk.kid);
  await page.getByRole("dialog").getByRole("button", { name: "Revoke this key" }).dblclick();
  await see(w, page, "QA order system is revoked.");
  await page.waitForTimeout(500);
  if (posts(w, /\/connectors\/[^/]+\/revoke$/).length !== 1) w.note(`a double click on Revoke sent ${posts(w, /\/connectors\/[^/]+\/revoke$/).length} revokes`);
  await shoot(w, page, "connectors-revoked", { keys: true });
  const refused = await sendCatalog(ctx.troothId, pasted.privateJwk);
  if (refused.status !== 401 && refused.status !== 403) w.note(`a catalog request signed with a revoked key answered ${refused.status}`);
  // Revoked keys are hidden behind Show revoked; the toggle shows them.
  const show = page.getByRole("button", { name: /Show \d+ revoked key/ });
  if (await show.count()) {
    await show.click();
    await see(w, page, "Revoked");
    await shoot(w, page, "connectors-show-revoked");
  }
}
