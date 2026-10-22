// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The setup wizard's state (docs/spec/setup-api.md): the record the server
// keeps per company, the step the company is on, the next action, the plain
// words for every page left out, and the review document's sections. The
// server, not the browser, decides what is done (Stripe hosted onboarding:
// "No state is passed with this URL"; Yoast's first-time configuration: each
// step can be reopened). Pure functions over plain values; src/pipeline.ts
// reads the stores and calls these.

import type { Fact } from "../core/semanto";
import type { HostKind } from "../settings/delivery";
import type { SetupStepId } from "../basic/tier";
import type { ResolverAnswer } from "./dns-diagnosis";
import type { InstallCheckResult } from "./install-check";

export type SetupStep = "company" | "prove" | "read" | "review" | "install" | "done";

/** What the server keeps for one company's setup (semanto_setup.state_json). */
export interface SetupRecord {
  trooth_id: string;
  started_at: string;
  /** The address setup emails go to: the session that started setup. */
  owner_email: string | null;
  /** When each of the nine steps finished. */
  steps: Partial<Record<SetupStepId, string>>;
  /** The proof value, trooth-domain-challenge= and 48 hex. */
  challenge: string;
  challenge_issued_at: string;
  previous_challenges: string[];
  /** When Trooth started looking (the claim, or Look again). */
  looking_since: string;
  /** The last DNS lookup, reused for 10 seconds. */
  last_check: { at: string; resolvers: ResolverAnswer[]; well_known: string | null } | null;
  /** The DNS host read from NS records, looked up once. */
  provider: { id: string; name: string; where: string; checked_at: string } | null;
  /** The build that reads the site for setup. */
  build_id: string | null;
  /** The build whose finish was emailed, so one email per read. */
  emailed_build_id: string | null;
  /** The path chosen on the receipt screen. */
  path: "basic" | "full" | null;
  saved_for_later: boolean;
  saved_screen: string | null;
  saved_at: string | null;
  confirmed: { version: number; root_hash: string; at: string } | null;
  host_override: HostKind | null;
  detection: { host: HostKind; at: string } | null;
  install: InstallCheckResult | null;
  monitoring: { started_at: string; questions: string[]; competitors: { name: string; domain: string }[] } | null;
  /** True once the owner was emailed that the proof record was found. */
  proof_emailed: boolean;
}

/** Once every 10 seconds per company: a poll inside the window answers the last lookup. */
export const DNS_CHECK_INTERVAL_MS = 10_000;
/** Host detection at most once an hour unless asked. */
export const DETECT_INTERVAL_MS = 60 * 60 * 1000;
/** A read that took longer than this is followed by an email when it finishes. */
export const LONG_READ_MS = 60_000;

export function newSetupRecord(trooth_id: string, now: string, challenge: string, owner_email: string | null, signed_in_at: string | null): SetupRecord {
  const started_at = signed_in_at && Date.parse(signed_in_at) <= Date.parse(now) ? signed_in_at : now;
  return {
    trooth_id,
    started_at,
    owner_email,
    steps: { sign_in: started_at },
    challenge,
    challenge_issued_at: now,
    previous_challenges: [],
    looking_since: now,
    last_check: null,
    provider: null,
    build_id: null,
    emailed_build_id: null,
    path: null,
    saved_for_later: false,
    saved_screen: null,
    saved_at: null,
    confirmed: null,
    host_override: null,
    detection: null,
    install: null,
    monitoring: null,
    proof_emailed: false,
  };
}

// ---------------------------------------------------------------- pages left out, in plain words

export type LeftOutCode = "noindex" | "robots" | "not_found" | "server_error" | "login" | "personal" | "duplicate" | "too_large" | "not_reached" | "not_html" | "other";

export const LEFT_OUT_WORDS: Record<LeftOutCode, string> = {
  noindex: "Asked search engines not to show it (noindex)",
  robots: "Blocked by your robots.txt",
  not_found: "Page not found (404)",
  server_error: "Server error (5xx)",
  login: "Needs a login",
  personal: "A cart, account or personal page",
  duplicate: "Same page as another one",
  too_large: "Too large to read",
  not_reached: "Not reached: no link to it from your site or sitemap",
  not_html: "Not a web page",
  other: "Could not be read",
};

/** The compiler's reason (src/compiler/build.ts and discover.ts) turned into the plain words the receipt shows. */
export function leftOutCode(reason: string): LeftOutCode {
  const r = reason.toLowerCase();
  if (r.includes("noindex")) return "noindex";
  if (r.includes("robots.txt")) return "robots";
  if (/answered 40[14]|answered 410/.test(r)) return /40[1]/.test(r) ? "login" : "not_found";
  if (/answered 403/.test(r)) return "login";
  if (/answered 5\d\d/.test(r)) return "server_error";
  if (/login page|admin page/.test(r)) return "login";
  if (/account page|cart page|personalized page/.test(r)) return "personal";
  if (r.startsWith("canonical is")) return "duplicate";
  if (r.includes("2 mb cap")) return "too_large";
  if (r === "not fetched") return "not_reached";
  if (r.startsWith("not an html page")) return "not_html";
  return "other";
}

export function leftOutPlain(list: { url: string; reason: string }[]): { url: string; reason: string; code: LeftOutCode }[] {
  return list.map((l) => {
    const code = leftOutCode(l.reason);
    return { url: l.url, reason: LEFT_OUT_WORDS[code], code };
  });
}

// ---------------------------------------------------------------- the review document

export type SectionId = "company" | "products" | "contact" | "policies";
export const SECTION_TITLES: Record<SectionId, string> = { company: "Company", products: "Products", contact: "Contact and hours", policies: "Policies" };

export function sectionOf(key: string): SectionId {
  const k = key.toLowerCase();
  if (/^(company|org|organization|identity|about|founded|legal|brand|team|people)\b|^company\./.test(k)) return "company";
  if (/^(product|products|offer|offers|pricing|price|plan|plans|service|services)\b|^products?\./.test(k)) return "products";
  if (/^(contact|address|phone|email|hours|opening|location|local)\b|^contact\./.test(k)) return "contact";
  return "policies";
}

export function reviewSections(facts: Fact[], titles: Map<string, string>): { id: SectionId; title: string; facts: { id: string; key: string; statement: string; value: unknown; provenance: Fact["provenance"]; source_url: string; source_title: string | null }[] }[] {
  const order: SectionId[] = ["company", "products", "contact", "policies"];
  return order.map((id) => ({
    id,
    title: SECTION_TITLES[id],
    facts: facts
      .filter((f) => sectionOf(f.key) === id)
      .map((f) => ({ id: f.id, key: f.key, statement: f.statement, value: f.value ?? null, provenance: f.provenance, source_url: f.evidence.url, source_title: titles.get(f.evidence.url) ?? null })),
  }));
}

// ---------------------------------------------------------------- the step and the next action

export interface StepInputs {
  hasCompany: boolean;
  proven: boolean;
  basic: boolean;
  readDone: boolean;
  path: "basic" | "full" | null;
  confirmed: boolean;
  signed: boolean;
  installPassed: boolean;
  monitoringStarted: boolean;
}

/** The step, in the order docs/spec/setup-api.md states. */
export function decideStep(i: StepInputs): SetupStep {
  if (!i.hasCompany) return "company";
  if (!i.proven) return "prove";
  if (!i.readDone || i.path === null) return "read";
  if (i.basic) return "done";
  if (!i.confirmed || !i.signed) return "review";
  if (!i.installPassed || !i.monitoringStarted) return "install";
  return "done";
}

export interface NextAction {
  label: string;
  method: "GET" | "POST";
  url: string;
}

/**
 * The one action the wizard offers. At the sign step: hosted custody adds a
 * passkey first when the person has none (POST passkeys/options), then asks
 * for the passkey request bound to the version (POST sign/options); the key is
 * released only after that assertion (src/pipeline-passkeys.ts). Customer
 * custody asks for the signing input (POST sign).
 */
export function nextAction(step: SetupStep, ctx: { osBase: string; trooth_id: string | null; readDone: boolean; confirmed: boolean; installPassed: boolean; custody?: "hosted" | "customer"; hasPasskey?: boolean; provider?: { name: string; domain_connect_url?: string } }): NextAction | null {
  const b = ctx.trooth_id ? `${ctx.osBase}/${ctx.trooth_id}` : ctx.osBase;
  switch (step) {
    case "company":
      return { label: "Continue", method: "POST", url: `${ctx.osBase}/setup/start` };
    case "prove":
      if (ctx.provider?.domain_connect_url) return { label: `Add it at ${ctx.provider.name}`, method: "GET", url: ctx.provider.domain_connect_url };
      return { label: "Add the record, then wait here", method: "GET", url: `${b}/setup` };
    case "read":
      return ctx.readDone ? { label: "Finish setup", method: "POST", url: `${b}/setup/choose` } : { label: "Wait for the read", method: "GET", url: `${b}/setup` };
    case "review":
      if (!ctx.confirmed) return { label: "Confirm these facts", method: "POST", url: `${b}/setup/confirm` };
      if (ctx.custody === "customer") return { label: "Sign with our own key", method: "POST", url: `${b}/sign` };
      return ctx.hasPasskey ? { label: "Sign with my passkey", method: "POST", url: `${b}/sign/options` } : { label: "Add a passkey", method: "POST", url: `${b}/passkeys/options` };
    case "install":
      return ctx.installPassed ? { label: "Start monitoring", method: "POST", url: `${b}/setup/monitoring` } : { label: "Check my site", method: "POST", url: `${b}/setup/install-check` };
    case "done":
      return null;
  }
}

/** Seconds left at the measured rate, once at least one page is done. */
export function etaSeconds(pagesDone: number, found: number, startedAt: string | null, nowMs: number): number | undefined {
  if (!startedAt || pagesDone <= 0 || found <= pagesDone) return undefined;
  const elapsed = (nowMs - Date.parse(startedAt)) / 1000;
  if (!(elapsed > 0)) return undefined;
  return Math.max(1, Math.round((elapsed / pagesDone) * (found - pagesDone)));
}
