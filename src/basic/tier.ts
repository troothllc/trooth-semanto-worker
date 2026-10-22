// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto Basic: the free tier that needs only domain proof. A state machine
//
//   claim -> domain_proved -> basic_built -> upgraded
//
// Domain proof is a DNS TXT record at _trooth.<domain> or a well-known file,
// the same two methods ACME uses (RFC 8555, dns-01 and http-01) and Google
// Search Console offers. Once proved, Trooth builds and hosts the record from
// the public site in state "read": the company signs nothing yet, so the
// record is witnessed by Trooth and not signed by the company, and every
// Basic response says so in those words. "Upgraded" is the full tier after the
// Trust Profile, when the company's own key signs the version.
//
// The ten-minute setup is a checklist with a timing target per step, and the
// time spent is measured from timestamps, so the target is measured, not
// claimed.

import { isTroothId } from "../core/ids";
import type { BuiltRecord, DomainProofPort, RecordBuilderPort } from "./ports";

export type BasicState = "claim" | "domain_proved" | "basic_built" | "upgraded";

export type ProofMethod = "dns_txt" | "well_known";

export interface BasicCompany {
  trooth_id: string;
  domain: string;
  state: BasicState;
  /** The token the company must publish to prove the domain. */
  claim_token: string;
  claimed_at: string;
  domain_proved_at?: string;
  proof_method?: ProofMethod;
  basic_built_at?: string;
  record?: BuiltRecord;
  upgraded_at?: string;
}

export const WITNESSED_NOT_SIGNED = "This record is witnessed by Trooth and not signed by the company. Semanto Basic builds it from the public site; the company has not signed it.";

export const DNS_NAME_PREFIX = "_trooth";
export const WELL_KNOWN_PATH = "/.well-known/trooth-claim.txt";

export function dnsClaimRecord(token: string): string {
  return `v=trooth1; claim=${token}`;
}

export function dnsClaimName(domain: string): string {
  return `${DNS_NAME_PREFIX}.${domain.toLowerCase()}`;
}

export function wellKnownClaimUrl(domain: string): string {
  return `https://${domain.toLowerCase()}${WELL_KNOWN_PATH}`;
}

/** What Basic serves and what it does not. Data, so the dashboard and the docs read the same list. */
export const BASIC_ENTITLEMENTS = {
  serves: [
    { id: "hosted_copy", words: "The Trooth-hosted copy of your record, at api.trooth.co and trooth.co" },
    { id: "head_tag", words: "Head-tag mode: one line in your site's <head> that points agents at the hosted copy" },
    { id: "competitor_report", words: "The competitor report: what AI assistants say about you and up to three others" },
    { id: "alerts", words: "Alerts when an assistant's answer differs from your record" },
  ],
  does_not: [
    { id: "company_signature", words: "Your own signature. In Basic the record is witnessed by Trooth and not signed by you." },
    { id: "own_domain_serving", words: "Serving the record from your own domain through an adapter" },
    { id: "commerce", words: "Signed offers and feeds" },
  ],
  state_of_record: "read" as const,
} as const;

// ------------------------------------------------------------------ transitions

export function claim(trooth_id: string, domain: string, claim_token: string, now: Date): BasicCompany {
  if (!isTroothId(trooth_id)) throw new Error("claim: not a Trooth id");
  const d = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error("claim: not a domain");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(claim_token)) throw new Error("claim: token too short");
  return { trooth_id, domain: d, state: "claim", claim_token, claimed_at: now.toISOString() };
}

export type ProofOutcome =
  | { ok: true; company: BasicCompany; method: ProofMethod }
  | { ok: false; reason: "no_record_found" | "token_mismatch" | "already_proved"; checked: { dns_name: string; dns_values: string[]; well_known_url: string; well_known_found: boolean } };

/** Check DNS first, then the well-known file. Either one proves the domain. */
export async function proveDomain(c: BasicCompany, port: DomainProofPort, now: Date): Promise<ProofOutcome> {
  const dns_name = dnsClaimName(c.domain);
  const well_known_url = wellKnownClaimUrl(c.domain);
  const dns_values = await port.dnsTxt(dns_name);
  const file = await port.fetchText(well_known_url);
  const checked = { dns_name, dns_values, well_known_url, well_known_found: file !== null };
  if (c.state !== "claim") return { ok: false, reason: "already_proved", checked };
  const want = dnsClaimRecord(c.claim_token);
  const dnsOk = dns_values.some((v) => v.trim().replace(/^"|"$/g, "") === want);
  if (dnsOk) return { ok: true, method: "dns_txt", company: { ...c, state: "domain_proved", domain_proved_at: now.toISOString(), proof_method: "dns_txt" } };
  if (file !== null) {
    if (file.trim() === c.claim_token) return { ok: true, method: "well_known", company: { ...c, state: "domain_proved", domain_proved_at: now.toISOString(), proof_method: "well_known" } };
    return { ok: false, reason: "token_mismatch", checked };
  }
  if (dns_values.length) return { ok: false, reason: "token_mismatch", checked };
  return { ok: false, reason: "no_record_found", checked };
}

export type BuildOutcome = { ok: true; company: BasicCompany } | { ok: false; reason: "domain_not_proved" | "already_built"; words: string };

/** Refuses to build until the domain is proved. The built record is in state "read". */
export async function buildBasic(c: BasicCompany, builder: RecordBuilderPort, now: Date): Promise<BuildOutcome> {
  if (c.state === "claim") return { ok: false, reason: "domain_not_proved", words: `Prove ${c.domain} first: add the DNS record or the well-known file, then try again.` };
  if (c.state !== "domain_proved") return { ok: false, reason: "already_built", words: "This record is already built." };
  const record = await builder.build(c.domain, c.trooth_id);
  return { ok: true, company: { ...c, state: "basic_built", basic_built_at: now.toISOString(), record } };
}

export type UpgradeOutcome = { ok: true; company: BasicCompany } | { ok: false; reason: "not_built" | "trust_profile_incomplete" | "already_upgraded"; words: string };

export function upgrade(c: BasicCompany, trustProfile: { published: boolean; key_kid: string | null }, now: Date): UpgradeOutcome {
  if (c.state === "upgraded") return { ok: false, reason: "already_upgraded", words: "This company is already on the full tier." };
  if (c.state !== "basic_built") return { ok: false, reason: "not_built", words: "Build the Basic record first." };
  if (!trustProfile.published || !trustProfile.key_kid) return { ok: false, reason: "trust_profile_incomplete", words: "Finish and publish the Trust Profile, with a signing key, to move to the full tier." };
  return { ok: true, company: { ...c, state: "upgraded", upgraded_at: now.toISOString() } };
}

// ------------------------------------------------------------------ every Basic response

export interface BasicEnvelope<T> {
  tier: "basic";
  state: BasicState;
  record_state: "read";
  witnessed_by: "Trooth";
  signed_by_company: false;
  notice: typeof WITNESSED_NOT_SIGNED;
  body: T;
}

/** Wrap anything Basic serves so the reader is told, every time, that the record is witnessed and not signed. */
export function basicResponse<T>(c: BasicCompany, body: T): BasicEnvelope<T> {
  if (c.state === "upgraded") throw new Error("basicResponse: an upgraded company is served by the full tier");
  return { tier: "basic", state: c.state, record_state: "read", witnessed_by: "Trooth", signed_by_company: false, notice: WITNESSED_NOT_SIGNED, body };
}

export function basicHeaders(): Record<string, string> {
  return { "Trooth-Record-State": "read", "Trooth-Witnessed-By": "Trooth", "Trooth-Signed-By-Company": "no" };
}

// ------------------------------------------------------------------ the ten-minute setup

export interface SetupStep {
  id: string;
  words: string;
  /** Who does it. */
  who: "company" | "trooth";
  target_seconds: number;
}

/** Targets sum to 600 seconds. They are targets; `measureSetup` reports what was spent. */
export const SETUP_CHECKLIST: SetupStep[] = [
  { id: "enter_domain", words: "Type your domain", who: "company", target_seconds: 30 },
  { id: "publish_token", words: "Add the DNS record or upload the well-known file", who: "company", target_seconds: 240 },
  { id: "prove_domain", words: "Trooth checks the record", who: "trooth", target_seconds: 60 },
  { id: "build_record", words: "Trooth reads your public site and builds the record", who: "trooth", target_seconds: 180 },
  { id: "add_head_tag", words: "Paste one line into your site's <head>", who: "company", target_seconds: 60 },
  { id: "first_report", words: "Trooth starts your first competitor report", who: "trooth", target_seconds: 30 },
];

export interface StepTiming {
  id: string;
  target_seconds: number;
  spent_seconds: number | null;
  within_target: boolean | null;
}

export interface SetupTiming {
  steps: StepTiming[];
  total_target_seconds: number;
  total_spent_seconds: number | null;
  within_ten_minutes: boolean | null;
  /** Steps with no timestamps yet. */
  not_started: string[];
}

/**
 * Time spent per step from timestamps: `started` is when the checklist was
 * opened, and each entry in `completed_at` is when that step finished. A step
 * is measured from the previous step's completion (or from `started`).
 */
export function measureSetup(started: string, completed_at: Partial<Record<string, string>>): SetupTiming {
  let prev = Date.parse(started);
  const steps: StepTiming[] = [];
  const not_started: string[] = [];
  let total = 0;
  let complete = true;
  for (const s of SETUP_CHECKLIST) {
    const done = completed_at[s.id];
    if (!done) {
      steps.push({ id: s.id, target_seconds: s.target_seconds, spent_seconds: null, within_target: null });
      not_started.push(s.id);
      complete = false;
      continue;
    }
    const t = Date.parse(done);
    const spent = Math.max(0, Math.round((t - prev) / 1000));
    steps.push({ id: s.id, target_seconds: s.target_seconds, spent_seconds: spent, within_target: spent <= s.target_seconds });
    total += spent;
    prev = t;
  }
  const total_target_seconds = SETUP_CHECKLIST.reduce((n, s) => n + s.target_seconds, 0);
  return { steps, total_target_seconds, total_spent_seconds: complete ? total : null, within_ten_minutes: complete ? total <= 600 : null, not_started };
}
