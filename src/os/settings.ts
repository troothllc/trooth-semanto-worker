// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Delivery settings (contract section 1a): the preview answers what a change
// does before Save, route by route, without saving (the "review changes"
// step Cloudflare's dashboard and Vercel's project settings show before a
// deploy-affecting save); Save stores the merged settings and appends an
// audit row. Validation is src/settings/delivery.ts validateSettings, the
// same sentences the screen already shows.

import { contentSignalHeader, describeMode, validateSettings, withDefaults, DEFAULT_SETTINGS, type DeliverySettings } from "../settings/delivery";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { ADMIN_ONLY, audit, isRecord, mayAdminister, ok, problem, type RequestContext } from "./common";
import type { OsService } from "./service";

export interface SettingsEffect {
  route: string;
  before: string;
  after: string;
}

const served = (on: boolean, what: string) => (on ? `served (${what})` : "404 representation_not_offered (turned off)");

/** What changes for readers, route by route, between two settings. */
export function settingsEffects(trooth_id: string, before: DeliverySettings, after: DeliverySettings): SettingsEffect[] {
  const b = `/public/semanto/${trooth_id}`;
  const out: SettingsEffect[] = [];
  const fmt = (on: keyof DeliverySettings["formats"], routes: string[], what: string) => {
    if (before.formats[on] === after.formats[on]) return;
    for (const route of routes) out.push({ route, before: served(before.formats[on], what), after: served(after.formats[on], what) });
  };
  fmt("markdown", [`${b}/pages/{page}.md`, `${b}/by-path/{path}.md`], "signed markdown");
  fmt("jsonld", [`${b}/facts.jsonld`, `${b}/pages/{page}.jsonld`], "JSON-LD");
  fmt("llms", [`${b}/llms.txt`, `${b}/llms-full.txt`], "llms.txt");
  fmt("sitemap_md", [`${b}/sitemap.md`], "sitemap.md");
  if (before.content_signals["ai-train"] !== after.content_signals["ai-train"] || before.content_signals.search !== after.content_signals.search || before.content_signals["ai-input"] !== after.content_signals["ai-input"]) {
    out.push({ route: `${b}/* Content-Signal header`, before: contentSignalHeader(before.content_signals), after: contentSignalHeader(after.content_signals) });
  }
  if (before.when_page_changed !== after.when_page_changed) {
    const words: Record<DeliverySettings["when_page_changed"], string> = {
      serve_last_signed_marked_behind: "the last signed page, marked behind",
      serve_live_marked_unsigned: "a 303 to the live page, marked unsigned",
      prompt_to_sign: "the last signed page, marked behind, and an email asking to sign",
    };
    out.push({ route: `${b}/pages/{page} when the live page changed`, before: words[before.when_page_changed], after: words[after.when_page_changed] });
  }
  if (before.markdown_source !== after.markdown_source || before.host !== after.host || before.where.own_domain !== after.where.own_domain) {
    out.push({ route: "markdown requests on your own domain", before: describeMode(before).mode, after: describeMode(after).mode });
  }
  return out;
}

async function current(s: OsService, trooth_id: string): Promise<DeliverySettings> {
  return (await s.p.d.settings.get(trooth_id)) ?? DEFAULT_SETTINGS;
}

/** GET /os/semanto/{id}/settings: the settings with the company's domain, the detected host and when they were last saved. */
export async function settingsView(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const setup = await s.p.d.store.getSetup(trooth_id);
  const saved = await s.store.lastAudit(trooth_id, "settings.save");
  return ok(200, { object: "semanto.settings", trooth_id, domain: company.domain, settings: await current(s, trooth_id), detection: setup?.detection ?? null, updated_at: saved?.at ?? null });
}

/** POST /os/semanto/{id}/settings/preview: the same body as Save; nothing is stored. */
export async function previewSettings(s: OsService, ws: WorkspaceAuth, trooth_id: string, input: unknown): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change delivery settings");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const merged = withDefaults((isRecord(input) ? input : {}) as Partial<DeliverySettings>);
  const issues = validateSettings(merged);
  const before = await current(s, trooth_id);
  return ok(200, { object: "semanto.settings_preview", issues, effects: issues.length ? [] : settingsEffects(trooth_id, before, merged) });
}

/** POST /os/semanto/{id}/settings: validate, store, audit. */
export async function saveSettings(s: OsService, ws: WorkspaceAuth, trooth_id: string, input: unknown, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change delivery settings");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const merged = withDefaults((isRecord(input) ? input : {}) as Partial<DeliverySettings>);
  const issues = validateSettings(merged);
  if (issues.length) return { status: 0, problem: { code: "settings_invalid", detail: issues.map((i) => i.message).join(" "), extensions: { issues } } };
  const before = await current(s, trooth_id);
  await s.p.d.settings.put(trooth_id, merged);
  await audit(s.store, { trooth_id, ws, action: "settings.save", target: "delivery", before, after: merged, ctx, at: s.now() });
  return settingsView(s, trooth_id);
}
