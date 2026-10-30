// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto Basic: the free tier that needs only domain proof. A state machine
//
//   claim -> domain_proved -> basic_built -> upgraded
//
// One domain proof record format (docs/audit/workflow-research.md section 6,
// item 1, the Domain Connect template's split): the proof is a DNS TXT record
// at _trooth-challenge.<domain> whose value is trooth-domain-challenge= and 48
// lowercase hex characters, or the same value in the well-known file
// /.well-known/trooth-claim.txt, the two methods ACME uses (RFC 8555, dns-01
// and http-01) and Google Search Console offers. _trooth.<domain> is reserved
// for the pointer v=trooth1; id=<trooth_id>; key=<kid> and is never read as
// proof. The domain is the one fixed at the claim; a proof never names another.
// Once proved, the record Trooth read from the public site (a read may start
// before the proof and is held) is witnessed by Trooth and not signed by the
// company, and every Basic response says so in those words. "Upgraded" is the
// full tier, when the company's own key signs the version.
//
// The setup is nine steps with a timing target each (section 5): Basic is
// steps 1 to 4 within 600 seconds, the full path steps 1 to 9 within 900. The
// time spent is measured from server timestamps, so the target is measured,
// not claimed.

import { isTroothId } from "../core/ids";
import type { BuiltRecord, DomainProofPort, RecordBuilderPort } from "./ports";

export type BasicState = "claim" | "domain_proved" | "basic_built" | "upgraded";

/** How a domain was proven. "trooth_domain_claim": confirmed on trooth.co (src/setup/workspace-domains.ts), the one proof for a trooth.co workspace; "dns_txt" and "well_known" are proofs recorded before one signup. */
export type ProofMethod = "dns_txt" | "well_known" | "trooth_domain_claim";

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

/** The proof record's name prefix: _trooth-challenge.<domain>. */
export const DNS_NAME_PREFIX = "_trooth-challenge";
/** Reserved for the pointer record v=trooth1; id=<trooth_id>; key=<kid>. Never read as proof. */
export const POINTER_NAME_PREFIX = "_trooth";
export const WELL_KNOWN_PATH = "/.well-known/trooth-claim.txt";
export const CHALLENGE_PREFIX = "trooth-domain-challenge=";
export const CHALLENGE_RE = /^trooth-domain-challenge=[0-9a-f]{48}$/;
export const POINTER_RE = /^v=trooth1;\s*id=[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?;\s*key=[A-Za-z0-9_-]{16,128}$/;

/** A fresh proof value from 24 random bytes: trooth-domain-challenge= and 48 lowercase hex. */
export function newChallenge(random: Uint8Array): string {
  if (random.length !== 24) throw new Error("newChallenge: 24 random bytes");
  return CHALLENGE_PREFIX + [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The TXT value to publish. The proof value is the whole record. */
export function dnsClaimRecord(token: string): string {
  return token;
}

/** The proof record's name: _trooth-challenge.<domain>. */
export function dnsClaimName(domain: string): string {
  return `${DNS_NAME_PREFIX}.${domain.toLowerCase()}`;
}

/** The pointer record's name: _trooth.<domain>. */
export function pointerRecordName(domain: string): string {
  return `${POINTER_NAME_PREFIX}.${domain.toLowerCase()}`;
}

/** The pointer record's value. */
export function pointerRecordValue(trooth_id: string, kid: string): string {
  return `v=trooth1; id=${trooth_id}; key=${kid}`;
}

export function wellKnownClaimUrl(domain: string): string {
  return `https://${domain.toLowerCase()}${WELL_KNOWN_PATH}`;
}

/**
 * Clean what a person pastes into the website field: the scheme, a leading
 * www., any path, query, fragment and port go, and the host is lowercased.
 * Null when what is left is not a domain name.
 */
export function cleanDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  d = d.replace(/^www\./, "");
  if (d.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  return d;
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
  const d = cleanDomain(domain);
  if (!d) throw new Error("claim: not a domain");
  if (!CHALLENGE_RE.test(claim_token)) throw new Error("claim: not a proof value (trooth-domain-challenge= and 48 hex)");
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
  const dnsOk = dns_values.some((v) => v.trim().replace(/^"+|"+$/g, "").trim() === want);
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

// ------------------------------------------------------------------ the setup: eight steps, measured

export type SetupStepId = "sign_in" | "company" | "prove_domain" | "read_site" | "review" | "sign" | "install" | "check";

export interface SetupStep {
  n: number;
  id: SetupStepId;
  words: string;
  /** Who does it. */
  who: "owner" | "trooth" | "owner_then_trooth" | "trooth_then_owner";
  /** Target in Basic, or null when the step is not in Basic. */
  basic_seconds: number | null;
  full_seconds: number;
}

/** docs/audit/workflow-research.md section 5. Basic steps 1 to 4 sum to 570 (target 600); full steps 1 to 8 to 825 (target 900). */
export const SETUP_STEPS: SetupStep[] = [
  { n: 1, id: "sign_in", words: "Sign in", who: "owner", basic_seconds: 30, full_seconds: 30 },
  { n: 2, id: "company", words: "Name your company and website", who: "owner", basic_seconds: 30, full_seconds: 30 },
  { n: 3, id: "prove_domain", words: "Prove you control the domain", who: "owner_then_trooth", basic_seconds: 270, full_seconds: 270 },
  { n: 4, id: "read_site", words: "Trooth reads your site; you look at what it read", who: "trooth_then_owner", basic_seconds: 240, full_seconds: 240 },
  { n: 5, id: "review", words: "Review and confirm the facts", who: "owner", basic_seconds: null, full_seconds: 60 },
  { n: 6, id: "sign", words: "Sign the version", who: "owner", basic_seconds: null, full_seconds: 45 },
  { n: 7, id: "install", words: "Put it on your site", who: "owner", basic_seconds: null, full_seconds: 120 },
  { n: 8, id: "check", words: "Trooth checks it works", who: "trooth", basic_seconds: null, full_seconds: 30 },
];

export const BASIC_TARGET_SECONDS = 600;
export const FULL_TARGET_SECONDS = 900;

export interface StepTiming {
  id: SetupStepId;
  target_seconds: number;
  spent_seconds: number | null;
  within_target: boolean | null;
}

export interface PathTiming {
  target_seconds: number;
  spent_seconds: number | null;
  within_target: boolean | null;
}

export interface SetupTiming {
  steps: StepTiming[];
  basic: PathTiming;
  full: PathTiming;
  /** Steps with no timestamp yet. */
  not_started: SetupStepId[];
}

/**
 * Time spent per step from server timestamps: `started` is when setup began,
 * and each entry in `completed_at` is when that step finished. A step is
 * measured from the latest earlier completion (or from `started`), so a step
 * that overlaps an earlier one (the read runs during the proof) costs only
 * what is left over. The per-step target is the full-path target.
 */
export function measureSetup(started: string, completed_at: Partial<Record<SetupStepId, string>>): SetupTiming {
  let prev = Date.parse(started);
  const steps: StepTiming[] = [];
  const not_started: SetupStepId[] = [];
  const spentById = new Map<SetupStepId, number>();
  for (const s of SETUP_STEPS) {
    const done = completed_at[s.id];
    if (!done) {
      steps.push({ id: s.id, target_seconds: s.full_seconds, spent_seconds: null, within_target: null });
      not_started.push(s.id);
      continue;
    }
    const t = Date.parse(done);
    const spent = Math.max(0, Math.round((t - prev) / 1000));
    steps.push({ id: s.id, target_seconds: s.full_seconds, spent_seconds: spent, within_target: spent <= s.full_seconds });
    spentById.set(s.id, spent);
    prev = Math.max(prev, t);
  }
  const sum = (ids: SetupStepId[]): number | null => (ids.every((id) => spentById.has(id)) ? ids.reduce((n, id) => n + spentById.get(id)!, 0) : null);
  const basicIds = SETUP_STEPS.filter((s) => s.basic_seconds !== null).map((s) => s.id);
  const fullIds = SETUP_STEPS.map((s) => s.id);
  const basicSpent = sum(basicIds);
  const fullSpent = sum(fullIds);
  return {
    steps,
    basic: { target_seconds: BASIC_TARGET_SECONDS, spent_seconds: basicSpent, within_target: basicSpent === null ? null : basicSpent <= BASIC_TARGET_SECONDS },
    full: { target_seconds: FULL_TARGET_SECONDS, spent_seconds: fullSpent, within_target: fullSpent === null ? null : fullSpent <= FULL_TARGET_SECONDS },
    not_started,
  };
}
