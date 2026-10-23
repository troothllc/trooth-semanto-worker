// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: role differences and another company's trooth_id, through the real
// path (the browser's cookie, trooth-web's proxy, the Worker, the TROOTH_OS
// stand-in). Every write as member, viewer, the role-less teammate worker-f
// sends today, and another company's owner is refused and changes nothing;
// reads stay open to the company's own people; an admin cannot go back to one
// officer; an unconfirmed address and a two-day-old sign-in are asked to
// confirm before the writes that add reach. In the browser: what a member and
// a viewer see when they press a write.

import { load, shoot, see, control, d1, BASE, STACK } from "./lib.mjs";

const call = async (persona, method, path, body) => {
  const r = await fetch(`${BASE}/api/semanto/${path}`, { method, headers: { cookie: `trooth_session=${STACK.personas[persona].token}`, origin: BASE, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, redirect: "manual" });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

export async function roles(w, ctx) {
  const id = ctx.troothId;
  const writes = [
    ["settings", { where: { trooth_hosted: true, own_domain: true }, host: "unknown", formats: { markdown: true, jsonld: true, llms: true, sitemap_md: true, whole_file: true }, markdown_source: "semanto_only", when_page_changed: "serve_last_signed_marked_behind", content_signals: { "ai-train": true, search: true, "ai-input": true } }],
    ["keys/rotation/start", { custody: "hosted" }],
    ["keys/rotation/cancel", { rotation_id: "rot_x" }],
    ["connectors", { public_jwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }, label: "x", source: "api" }],
    ["connectors/create", { source: "api", label: "x" }],
    ["google/connect", { products: ["merchant"] }],
    ["google/disconnect", { confirm: true }],
    ["company/signing-policy", { officers_required: 2 }],
    ["company/surfaces", { add: { kind: "marketplace", label: "x" } }],
    ["company/alerts", { add: "intruder@globex-qa.com" }],
    ["writeback/send", { confirm: true, idempotency_key: "qa-role-key-00000001" }],
    ["sellers/lists/options", { draft: { trooth_id: id, version: 99, issued_at: new Date().toISOString(), sellers: [] } }],
    ["recalls/options", { notice: {} }],
    ["passkeys/options", {}],
    ["sign/options", { version: 1 }],
  ];
  const auditBefore = (await d1("SELECT COUNT(*) AS n FROM semanto_audit WHERE trooth_id = ?", id))[0]?.n;
  for (const persona of ["member", "viewer", "norole", "globex"]) {
    w.step(`roles-${persona}`);
    for (const [path, body] of writes) {
      const r = await call(persona, "POST", `${id}/${path}`, body);
      if (r.status !== 403 && !(persona === "globex" && r.status === 404)) w.note(`${persona} POST ${path} answered ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      if (r.status === 403 && persona !== "globex" && typeof r.body?.detail !== "string") w.note(`${persona} POST ${path}: the refusal has no words`);
    }
  }
  const auditAfter = (await d1("SELECT COUNT(*) AS n FROM semanto_audit WHERE trooth_id = ?", id))[0]?.n;
  if (auditAfter !== auditBefore) w.note(`refused writes added ${auditAfter - auditBefore} audit rows`);
  const settings = JSON.parse((await control("/worker/fetch", { path: `/os/semanto/${id}/settings`, headers: { authorization: "Bearer qa-token-owner-acme" } })).text);
  if (settings.settings.content_signals["ai-train"]) w.note("a refused settings write changed the settings");

  // Reads: the company's own people read; another company's owner is refused.
  w.step("roles-reads");
  for (const path of ["settings", "keys", "receipts", "connectors", "google", "company", "writeback/runs", "sellers/lists", "credentials", "recalls"]) {
    for (const persona of ["member", "viewer"]) {
      const r = await call(persona, "GET", `${id}/${path}`);
      if (r.status !== 200) w.note(`${persona} GET ${path} answered ${r.status}`);
    }
    const g = await call("globex", "GET", `${id}/${path}`);
    if (g.status !== 403 && g.status !== 404) w.note(`another company's owner GET ${path} answered ${g.status}`);
    if (g.status === 200 || JSON.stringify(g.body ?? "").includes(STACK.companies.acme.domain)) w.note(`another company's owner read ${path}`);
  }
  // mayOperate: a member may test a connector; a viewer may not.
  const kid = (await d1("SELECT kid FROM semanto_connector_keys WHERE trooth_id = ? AND revoked_at IS NULL LIMIT 1", id))[0]?.kid;
  if (kid) {
    const m = await call("member", "POST", `${id}/connectors/${kid}/test`, {});
    if (m.status !== 200) w.note(`a member's connector test answered ${m.status}`);
    for (const p of ["member", "norole"]) { const b = await call(p, "POST", `${id}/keys/binding/check`, {}); if (b.status !== 200) w.note(`${p}'s DNS binding check answered ${b.status}`); }
    if ((await call("viewer", "POST", `${id}/keys/binding/check`, {})).status !== 403) w.note("a viewer's DNS binding check was not refused");
    const v = await call("viewer", "POST", `${id}/connectors/${kid}/test`, {});
    if (v.status !== 403) w.note(`a viewer's connector test answered ${v.status}`);
  }
  // An admin may not go back to one officer (owner only).
  w.step("roles-admin");
  await call("owner", "POST", `${id}/company/signing-policy`, { officers_required: 2 });
  const a = await call("admin", "POST", `${id}/company/signing-policy`, { officers_required: 1, confirm: "one officer" });
  if (a.status !== 403) w.note(`an admin going back to one officer answered ${a.status}`);
  await call("owner", "POST", `${id}/company/signing-policy`, { officers_required: 1, confirm: "one officer" });
  // An unconfirmed address and an old sign-in are asked to confirm before a write that adds reach.
  w.step("roles-step-up");
  const u = await call("unconfirmed", "POST", `${id}/connectors/create`, { source: "api", label: "x" });
  if (u.status !== 403) w.note(`an unconfirmed address creating a connector key answered ${u.status}`);
  const s = await call("ownerStale", "POST", `${id}/google/connect`, { products: ["merchant"] });
  if (s.status !== 403 || !JSON.stringify(s.body).includes("reauth")) w.note(`a two-day-old sign-in connecting Google answered ${s.status} ${JSON.stringify(s.body).slice(0, 160)}`);
  // Signed out: 401, nothing forwarded.
  const out = await fetch(`${BASE}/api/semanto/${id}/keys`);
  if (out.status !== 401) w.note(`signed out GET keys answered ${out.status}`);

  // In the browser: a member presses Start rotation; a viewer presses Add on alerts.
  w.step("roles-member-ui");
  const mp = await w.newPage("member", { passkey: true });
  await load(w, mp, "/dashboard/semanto/keys", "roles-member-keys");
  w.expect(403, /\/keys\/rotation\/start$/);
  await mp.getByRole("button", { name: "Start rotation" }).click();
  await see(w, mp, "Only an owner or admin can change signing keys.");
  await shoot(w, mp, "roles-member-refused", { keys: true });
  w.step("roles-viewer-ui");
  const vp = await w.newPage("viewer", { passkey: true });
  await load(w, vp, "/dashboard/semanto/company", "roles-viewer-company");
  w.expect(403, /\/company\/alerts$/);
  await vp.locator("section", { has: vp.getByRole("heading", { name: "Alert addresses" }) }).getByLabel("Add an address").fill("viewer@acmegoods-qa.com");
  await vp.locator("section", { has: vp.getByRole("heading", { name: "Alert addresses" }) }).getByRole("button", { name: "Add", exact: true }).click();
  await see(w, vp, /Only an owner or admin/);
  await shoot(w, vp, "roles-viewer-refused", { keys: true });
  // Another company's owner opening this company's screens sees their own company, never this one.
  w.step("roles-globex-ui");
  const gp = await w.newPage("globex", { passkey: true });
  await load(w, gp, "/dashboard/semanto", "roles-globex-guide");
  const text = await gp.locator("main").innerText();
  if (text.includes(STACK.companies.acme.domain)) w.note("another company's owner sees this company's domain");
  await shoot(w, gp, "roles-globex-guide");
}
