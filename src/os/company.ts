// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Company settings (contract section 2): the signing policy, the surfaces the
// signed record reaches, the alert addresses, and "Recent changes" from the
// audit trail.
//
//   signing policy   going from two officers to one is the destructive
//                    direction: it needs the typed words "one officer" and
//                    the owner, and is refused while a version waits for a
//                    second officer (GitHub's "type the repository name to
//                    confirm" for dangerous settings)
//   surfaces         removing a connected surface needs its id typed
//   alerts           an address stays pending until the link in the
//                    confirmation email is opened (double opt-in, as
//                    Mailchimp and Substack confirm a new subscriber); the
//                    link works once, for 24 hours, and its token is kept only
//                    as its SHA-256; a resend at most once a minute; alerts go
//                    to confirmed addresses only (CompanyConfig.alert_emails)

import { isDomainProven, type WorkspaceAuth, type WorkspaceResult } from "../serve/ports";
import type { CompanySurface } from "../pipeline-store";
import { ADMIN_ONLY, audit, cleanEmail, iso, isRecord, mayAdminister, ok, problem, randomId, randomToken, str, tokenHash, type RequestContext } from "./common";
import { newestValidSellerList } from "./sellers";
import type { OsService } from "./service";
import type { AlertAddress } from "./store";

export const ALERT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_ALERT_ADDRESSES = 10;
export const MAX_SURFACES = 50;
const SURFACE_KINDS: CompanySurface["kind"][] = ["website", "merchant_center", "business_profile", "marketplace", "app"];

/** GET /os/semanto/{id}/company. */
export async function companySettings(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const config = await s.p.d.store.getConfig(trooth_id);
  const google = await s.store.getGoogle(trooth_id);
  const connectors = (await s.store.connectors(trooth_id)).filter((c) => !c.revoked_at);
  const list = await newestValidSellerList(s, trooth_id);
  const website: CompanySurface = { kind: "website", id: "website", label: company.domain, url: `https://${company.domain}/` };
  const surfaces = [website, ...(config.company_surfaces ?? [])].map((x) => ({
    kind: x.kind,
    id: x.id,
    label: x.label,
    ...(x.url ? { url: x.url } : {}),
    ...(x.data_source ? { data_source: x.data_source } : {}),
    connected:
      x.kind === "website"
        ? isDomainProven(company)
        : x.kind === "merchant_center"
          ? google?.state === "connected" && google.products.includes("merchant")
          : x.kind === "business_profile"
            ? google?.state === "connected" && google.products.includes("business")
            : x.kind === "app"
              ? connectors.some((c) => c.source === x.id)
              : Boolean(list?.payload.sellers.some((e) => e.marketplace === x.id)),
  }));
  const alerts = await s.store.alertAddresses(trooth_id);
  return ok(200, {
    object: "semanto.company_settings",
    trooth_id,
    signing_policy: { officers_required: config.signing.officers === "two_officer" ? 2 : 1 },
    surfaces,
    // resend_available_at: when a pending address can be sent its confirmation again, so the screen can say when instead of failing.
    alert_addresses: alerts.map((a) => ({ address: a.address, state: a.state, added_at: a.added_at, confirmed_at: a.confirmed_at, ...(a.state === "pending" ? { resend_available_at: a.last_sent_at ? iso(new Date(Date.parse(a.last_sent_at) + RESEND_INTERVAL_MS)) : null } : {}) })),
    recent_changes: (await s.store.recentAudit(trooth_id, 20)).map((r) => ({ who: r.who, role: r.role, action: r.action, target: r.target, at: r.at, request_id: r.request_id, before_hash: r.before_hash, after_hash: r.after_hash })),
  });
}

/** POST /os/semanto/{id}/company/signing-policy. */
export async function setSigningPolicy(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change the signing policy");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const want = body.officers_required;
  if (want !== 1 && want !== 2) return problem("invalid_request", "officers_required is 1 or 2.");
  const config = await s.p.d.store.getConfig(trooth_id);
  const have = config.signing.officers === "two_officer" ? 2 : 1;
  if (want === have) return companySettings(s, trooth_id);
  if (want === 1) {
    if (ws.role !== "owner") return problem("forbidden", "Only the owner can turn two-officer signing off.");
    if (body.confirm !== "one officer") return problem("invalid_request", 'Turning two-officer signing off lets one person sign alone. Type the words to confirm: send { "officers_required": 1, "confirm": "one officer" }.');
    const latest = await s.p.d.store.latestVersion(trooth_id);
    if (latest && latest.file.header.state === "read" && (await s.p.d.store.authorizations(trooth_id, latest.file.root_hash)).length > 0) {
      return problem("conflict", `Version ${latest.file.header.version} is waiting for a second officer. Let the second officer approve it, or build a new version, before turning two-officer signing off.`);
    }
  }
  const signing = { ...config.signing, officers: want === 2 ? ("two_officer" as const) : ("single" as const) };
  await s.p.d.store.putConfig(trooth_id, { ...config, signing });
  await audit(s.store, { trooth_id, ws, action: "company.signing_policy", target: "signing_policy", before: { officers_required: have }, after: { officers_required: want }, ctx, at: s.now() });
  return companySettings(s, trooth_id);
}

/** A surface from the request. Without an id the Worker gives one (srf_ and 16 random bytes). */
function readSurface(v: unknown, generatedId: string): { ok: true; surface: CompanySurface } | { ok: false; detail: string } {
  if (!isRecord(v)) return { ok: false, detail: "add is a surface: { kind, id, label, url? }." };
  if (!SURFACE_KINDS.includes(v.kind as CompanySurface["kind"]) || v.kind === "website") return { ok: false, detail: "kind is merchant_center, business_profile, marketplace or app. Your website is always listed." };
  const id = v.id === undefined ? generatedId : str(v.id);
  const label = str(v.label);
  if (!id || id.length > 200 || !/^[A-Za-z0-9._:/@-]+$/.test(id)) return { ok: false, detail: "id is the surface's own id (for example accounts/123456789 or locations/987), at most 200 characters, no spaces; leave it out and Trooth gives one." };
  if (!label || label.length > 100) return { ok: false, detail: "label is a name of at most 100 characters." };
  const surface: CompanySurface = { kind: v.kind as CompanySurface["kind"], id, label };
  if (v.url !== undefined) {
    const u = str(v.url);
    let parsed: URL | null = null;
    try {
      parsed = u ? new URL(u) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:") return { ok: false, detail: "url is an https address." };
    surface.url = parsed.toString();
  }
  if (surface.kind === "merchant_center") {
    if (v.data_source !== undefined) {
      const ds = str(v.data_source);
      if (!ds || !/^accounts\/\d+\/dataSources\/\d+$/.test(ds)) return { ok: false, detail: "data_source is the Merchant API data source name, accounts/{account}/dataSources/{id}." };
      surface.data_source = ds;
    }
    if (v.content_language !== undefined) {
      if (typeof v.content_language !== "string" || !/^[a-z]{2}$/.test(v.content_language)) return { ok: false, detail: "content_language is a two-letter ISO 639-1 code, for example en." };
      surface.content_language = v.content_language;
    }
    if (v.feed_label !== undefined) {
      if (typeof v.feed_label !== "string" || !/^[A-Z0-9_-]{1,20}$/.test(v.feed_label)) return { ok: false, detail: "feed_label is up to 20 capital letters, digits, - or _, for example US." };
      surface.feed_label = v.feed_label;
    }
  }
  return { ok: true, surface };
}

/** The write-back targets follow the surfaces: the first Merchant Center account and the first Business Profile location. */
function writebackTargets(surfaces: CompanySurface[]) {
  const mc = surfaces.find((x) => x.kind === "merchant_center");
  const bp = surfaces.find((x) => x.kind === "business_profile");
  return {
    ...(mc ? { merchant_center: { merchantId: mc.id.replace(/^accounts\//, ""), contentLanguage: mc.content_language ?? "en", targetCountry: mc.feed_label ?? "US", ...(mc.data_source ? { dataSource: mc.data_source } : {}) } } : {}),
    ...(bp ? { business_profile_location: bp.id } : {}),
  };
}

/** POST /os/semanto/{id}/company/surfaces. */
export async function editSurfaces(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change the surfaces");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  if ((body.add === undefined) === (body.remove === undefined)) return problem("invalid_request", "Send either add (a surface) or remove (a surface id).");
  const config = await s.p.d.store.getConfig(trooth_id);
  const list = [...(config.company_surfaces ?? [])];
  const before = list.map((x) => ({ ...x }));
  let target: string;
  if (body.add !== undefined) {
    const r = readSurface(body.add, randomId("srf", (n) => s.random(n)));
    if (!r.ok) return problem("invalid_request", r.detail);
    const i = list.findIndex((x) => x.kind === r.surface.kind && x.id === r.surface.id);
    if (i >= 0) list[i] = r.surface;
    else {
      if (list.length >= MAX_SURFACES) return problem("conflict", `A company lists at most ${MAX_SURFACES} surfaces.`);
      list.push(r.surface);
    }
    target = r.surface.id;
  } else {
    const id = str(body.remove);
    if (id === "website") return problem("conflict", "Your website is always a surface and cannot be removed.");
    const found = list.find((x) => x.id === id);
    if (!id || !found) return problem("conflict", `No surface ${String(body.remove)} is listed.`);
    const view = (await companySettings(s, trooth_id)).body as { surfaces: { id: string; connected: boolean }[] };
    if (view.surfaces.find((x) => x.id === id)?.connected && body.confirm !== id) return problem("invalid_request", `${found.label} is connected. Type its id to confirm: send { "remove": "${id}", "confirm": "${id}" }.`);
    list.splice(list.indexOf(found), 1);
    target = id;
  }
  await s.p.d.store.putConfig(trooth_id, { ...config, company_surfaces: list, writeback: writebackTargets(list) });
  await audit(s.store, { trooth_id, ws, action: body.add !== undefined ? "company.surfaces.add" : "company.surfaces.remove", target, before, after: list, ctx, at: s.now() });
  return companySettings(s, trooth_id);
}

/** Keep CompanyConfig.alert_emails equal to the confirmed addresses: the monitor and the prompts write only to those. */
async function syncAlertEmails(s: OsService, trooth_id: string): Promise<void> {
  const confirmed = (await s.store.alertAddresses(trooth_id)).filter((a) => a.state === "confirmed").map((a) => a.address);
  const config = await s.p.d.store.getConfig(trooth_id);
  await s.p.d.store.putConfig(trooth_id, { ...config, alert_emails: confirmed });
}

async function sendConfirmation(s: OsService, trooth_id: string, address: string, token: string): Promise<boolean> {
  const company = await s.company(trooth_id);
  const link = `${s.publicBase()}/alerts/confirm?token=${encodeURIComponent(token)}`;
  const text = `Someone asked for Semanto alerts about ${company?.domain ?? trooth_id} to come to this address.\n\nConfirm it here (the link works once, for 24 hours): ${link}\n\nIf you did not ask, ignore this email and nothing will be sent.\n`;
  const sent = await s.d.email!.send({ from: s.d.from!, to: [address], subject: `Confirm alerts for ${company?.domain ?? trooth_id}`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
  return sent.ok;
}

/** GET /os/semanto/{id}/company/changes?before=: the audit trail 50 at a time, newest first, as GitHub's audit log pages. */
export async function changesPage(s: OsService, trooth_id: string, q: Record<string, string>): Promise<WorkspaceResult> {
  const before = q.before;
  if (before !== undefined && Number.isNaN(Date.parse(before))) return problem("invalid_request", "before is a time from the previous page's next_before.");
  const rows = await s.store.recentAudit(trooth_id, 51, before);
  const page = rows.slice(0, 50);
  return ok(200, { object: "semanto.changes", data: page.map((r) => ({ who: r.who, role: r.role, action: r.action, target: r.target, at: r.at, request_id: r.request_id, before_hash: r.before_hash, after_hash: r.after_hash })), next_before: rows.length > 50 ? page[page.length - 1]!.at : null });
}

/** POST /os/semanto/{id}/company/alerts: { add } | { remove, confirm } | { resend } | { test }. */
export async function editAlerts(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change the alert addresses");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const ops = ["add", "remove", "resend", "test"].filter((k) => body[k] !== undefined);
  if (ops.length !== 1) return problem("invalid_request", "Send one of add, remove (with confirm), resend or test, each an email address.");
  const op = ops[0]!;
  const address = cleanEmail(body[op]);
  if (!address) return problem("invalid_request", `${op} is an email address.`);
  const now = s.now();
  const list = await s.store.alertAddresses(trooth_id);
  const existing = list.find((a) => a.address === address);
  if (op === "remove") {
    if (!existing) return problem("conflict", `${address} is not on the alert list.`);
    if (cleanEmail(body.confirm) !== address) return problem("invalid_request", `Type the address to confirm: send { "remove": "${address}", "confirm": "${address}" }.`);
    await s.store.deleteAlertAddress(trooth_id, address);
    await syncAlertEmails(s, trooth_id);
    await audit(s.store, { trooth_id, ws, action: "company.alerts.remove", target: address, before: { address, state: existing.state }, after: null, ctx, at: now });
    return companySettings(s, trooth_id);
  }
  if (!s.d.email || !s.d.from) return problem("conflict", "Alert emails are not set up on this deployment yet (RESEND_API_KEY and ALERT_FROM), so no confirmation email can be sent. Nothing was changed.");
  // A test alert, as Stripe sends a test event to an endpoint: the same sender and wording an alert uses, to a confirmed
  // address, so a person sees where alerts land before one matters.
  if (op === "test") {
    if (!existing || existing.state !== "confirmed") return problem("conflict", `${address} is not a confirmed alert address. Confirm it first.`);
    if (existing.last_sent_at && now.getTime() - Date.parse(existing.last_sent_at) < RESEND_INTERVAL_MS) {
      const wait = Math.ceil((RESEND_INTERVAL_MS - (now.getTime() - Date.parse(existing.last_sent_at))) / 1000);
      return { status: 0, problem: { code: "rate_limited", detail: `An email went to ${address} less than a minute ago. Try again in ${wait} seconds.` }, headers: { "Retry-After": String(wait) } };
    }
    const company = await s.company(trooth_id);
    const domain = company?.domain ?? trooth_id;
    const text = `This is a test alert from Semanto for ${domain}.\n\nAlerts like this one come to this address when something about your signed copy needs you: a signing key to rotate, an install check that stopped passing, or a version that changed.\n\nNothing needs doing now.\n`;
    const sent = await s.d.email.send({ from: s.d.from, to: [address], subject: `Test alert for ${domain}`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
    if (!sent.ok) return problem("upstream_unavailable", `The test alert to ${address} did not go out. Try again in a few minutes.`);
    await s.store.putAlertAddress({ ...existing, last_sent_at: iso(now) });
    await audit(s.store, { trooth_id, ws, action: "company.alerts.test", target: address, after: { address }, ctx, at: now });
    return companySettings(s, trooth_id);
  }
  if (op === "add") {
    if (existing) return problem("conflict", existing.state === "confirmed" ? `${address} is already confirmed.` : `${address} is waiting for its confirmation. Send it again with resend.`);
    if (list.length >= MAX_ALERT_ADDRESSES) return problem("conflict", `A company keeps at most ${MAX_ALERT_ADDRESSES} alert addresses. Remove one first.`);
  } else {
    if (!existing) return problem("conflict", `${address} is not on the alert list. Add it first.`);
    if (existing.state === "confirmed") return problem("conflict", `${address} is already confirmed.`);
    if (existing.last_sent_at && now.getTime() - Date.parse(existing.last_sent_at) < RESEND_INTERVAL_MS) {
      const wait = Math.ceil((RESEND_INTERVAL_MS - (now.getTime() - Date.parse(existing.last_sent_at))) / 1000);
      return { status: 0, problem: { code: "rate_limited", detail: `A confirmation email went to ${address} less than a minute ago. Try again in ${wait} seconds.` }, headers: { "Retry-After": String(wait) } };
    }
  }
  const token = randomToken((n) => s.random(n));
  const row: AlertAddress = { trooth_id, address, state: "pending", token_hash: await tokenHash(token), token_expires_at: iso(new Date(now.getTime() + ALERT_LINK_TTL_MS)), added_at: existing?.added_at ?? iso(now), confirmed_at: null, last_sent_at: iso(now) };
  if (existing) await s.store.putAlertAddress(row);
  else if (!(await s.store.insertAlertAddress(row))) return problem("conflict", `${address} was just added by another request. Its confirmation email is on its way; send it again with resend after a minute.`);
  if (!(await sendConfirmation(s, trooth_id, address, token))) {
    if (!existing) await s.store.deleteAlertAddress(trooth_id, address);
    return problem("upstream_unavailable", `The confirmation email to ${address} did not go out. Nothing was added. Try again in a few minutes.`);
  }
  await audit(s.store, { trooth_id, ws, action: op === "add" ? "company.alerts.add" : "company.alerts.resend", target: address, before: existing ? { address, state: existing.state } : null, after: { address, state: "pending" }, ctx, at: now });
  return companySettings(s, trooth_id);
}

/** GET /public/semanto/alerts/confirm?token=: the link in the email. Always a redirect to the dashboard. */
export async function confirmAlert(s: OsService, token: string | undefined, ctx: RequestContext): Promise<{ location: string }> {
  const back = (q: string) => ({ location: `${s.dashboard()}/settings?${q}` });
  if (!token || token.length > 200) return back("alerts=error&reason=link_invalid");
  const now = s.now();
  const hash = await tokenHash(token);
  const row = await s.store.confirmAlertToken(hash, iso(now));
  // A pending address still holding this token means the link expired; no address with it means it never was a link or was used.
  if (!row) return back(`alerts=error&reason=${(await s.store.alertByToken(hash)) ? "link_expired" : "link_invalid"}`);
  await syncAlertEmails(s, row.trooth_id);
  await audit(s.store, { trooth_id: row.trooth_id, ws: { user_id: row.address, role: "public", name: row.address }, action: "company.alerts.confirm", target: row.address, before: { address: row.address, state: "pending" }, after: { address: row.address, state: "confirmed" }, ctx, at: now });
  return back("alerts=confirmed");
}
