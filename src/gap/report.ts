// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The gap report object: what AI assistants said about a company, compared
// line by line with the signed record, with the signed source for every
// mismatch. The object is content-addressed (smg_ id over its canonical body),
// renders to markdown a person can read, runs weekly on a Monday cron, and two
// reports diff into what changed by classification. Counts and shares only;
// no figure here is a judgment of the company.
//
// The weekly cadence follows the Cloudflare Workers Cron Triggers model (one
// cron expression in wrangler.toml, UTC) so the founder can paste it in.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId } from "../core/ids";
import { CLASSIFICATIONS, compareAnswer, type Classification, type CompareContext, type Finding } from "./compare";
import type { Question, QuestionKind } from "./prompts";
import { isAnswer, isNotConfigured, isProviderError, PROVIDER_LABELS, type AskResult, type ProviderAdapter, type ProviderName } from "./providers";

export interface ProviderSummary {
  provider: ProviderName;
  label: string;
  configured: boolean;
  /** Why it is not configured, when it is not. */
  reason?: string;
  questions_asked: number;
  /** Questions where the provider was configured but the request failed. */
  errors: number;
  /** The first failure's reason, as the provider gave it (status and message), so the owner sees why. */
  last_error?: string;
  model?: string;
}

export interface Correction {
  provider: ProviderName;
  question: string;
  said: string;
  signed_statement: string;
  fact_id: string;
  evidence_url: string;
}

export type Totals = Record<string, Record<Classification, number>>;

export interface CitationShare {
  /** Answers with at least one citation on the company's own domain. */
  cited_own_domain: number;
  /** Answers the provider gave (configured, no error). */
  answers: number;
  /** cited_own_domain / answers, 0 when there were no answers. */
  share: number;
}

export interface GapReport {
  object: "semanto.gap_report";
  id: string;
  trooth_id: string;
  company: string;
  domains: string[];
  kind: QuestionKind;
  ran_at: string;
  providers: ProviderSummary[];
  findings: Finding[];
  totals: Totals;
  corrections: Correction[];
  own_domain_citation_share: Record<string, CitationShare>;
}

export interface AskedQuestion {
  question: Question;
  results: AskResult[];
}

export interface BuildInput {
  trooth_id: string;
  company: string;
  kind: QuestionKind;
  ran_at: string;
  asked: AskedQuestion[];
  /** Every adapter the run had, so unconfigured ones are listed. */
  adapters: { provider: ProviderName; missing: string | null }[];
  context: CompareContext;
}

export function emptyTotals(): Record<Classification, number> {
  return { matches: 0, differs: 0, not_answered: 0, unsupported_claim: 0, cites_third_party: 0 };
}

/** Build the report from answers already collected. Pure apart from the digest. */
export async function buildGapReport(input: BuildInput): Promise<GapReport> {
  const findings: Finding[] = [];
  const totals: Totals = {};
  const share: Record<string, CitationShare> = {};
  const summaries = new Map<string, ProviderSummary>();
  for (const a of input.adapters) {
    summaries.set(a.provider, { provider: a.provider, label: PROVIDER_LABELS[a.provider], configured: a.missing === null, ...(a.missing ? { reason: a.missing } : {}), questions_asked: 0, errors: 0 });
    totals[a.provider] = emptyTotals();
    share[a.provider] = { cited_own_domain: 0, answers: 0, share: 0 };
  }
  for (const { question, results } of input.asked) {
    for (const r of results) {
      const s = summaries.get(r.provider) ?? { provider: r.provider, label: PROVIDER_LABELS[r.provider], configured: true, questions_asked: 0, errors: 0 };
      summaries.set(r.provider, s);
      totals[r.provider] ??= emptyTotals();
      share[r.provider] ??= { cited_own_domain: 0, answers: 0, share: 0 };
      if (isNotConfigured(r)) {
        s.configured = false;
        s.reason = r.reason;
        continue;
      }
      s.questions_asked += 1;
      if (isProviderError(r)) {
        s.errors += 1;
        s.last_error ??= r.error;
        continue;
      }
      if (!isAnswer(r)) continue;
      s.model = r.model;
      const sh = share[r.provider]!;
      sh.answers += 1;
      const fs = compareAnswer(question, r, input.context);
      if (fs.some((f) => f.citation === "own_domain")) sh.cited_own_domain += 1;
      for (const f of fs) {
        findings.push(f);
        totals[r.provider]![f.classification] += 1;
      }
    }
  }
  for (const sh of Object.values(share)) sh.share = sh.answers ? Math.round((sh.cited_own_domain / sh.answers) * 1000) / 1000 : 0;
  const corrections: Correction[] = findings
    .filter((f) => f.classification === "differs" && f.said && f.signed_statement && f.fact_id && f.evidence_url)
    .map((f) => ({ provider: f.provider, question: f.question, said: f.said!, signed_statement: f.signed_statement!, fact_id: f.fact_id!, evidence_url: f.evidence_url! }));
  const body = {
    object: "semanto.gap_report" as const,
    trooth_id: input.trooth_id,
    company: input.company,
    domains: input.context.domains,
    kind: input.kind,
    ran_at: input.ran_at,
    providers: [...summaries.values()],
    findings,
    totals,
    corrections,
    own_domain_citation_share: share,
  };
  const id = semantoId("smg", await digest(canonicalize(body)));
  return { id, ...body };
}

/** Ask every adapter every question, then build. The orchestration the cron and the route share. */
export async function runGapReport(
  input: Omit<BuildInput, "asked" | "adapters"> & { questions: Question[]; adapters: ProviderAdapter[]; concurrency?: number },
): Promise<GapReport> {
  const asked: AskedQuestion[] = [];
  const limit = Math.max(1, input.concurrency ?? 2);
  for (let i = 0; i < input.questions.length; i += limit) {
    const slice = input.questions.slice(i, i + limit);
    const rows = await Promise.all(slice.map(async (q) => ({ question: q, results: await Promise.all(input.adapters.map((a) => a.ask(q.text))) })));
    asked.push(...rows);
  }
  return buildGapReport({
    trooth_id: input.trooth_id,
    company: input.company,
    kind: input.kind,
    ran_at: input.ran_at,
    asked,
    adapters: input.adapters.map((a) => ({ provider: a.provider, missing: a.missing() })),
    context: input.context,
  });
}

// ------------------------------------------------------------------ markdown

const WORDS: Record<Classification, string> = {
  matches: "matches the signed record",
  differs: "differs from the signed record",
  not_answered: "not answered",
  unsupported_claim: "states something the record does not cover",
  cites_third_party: "matches, but cites only other sites",
};

export function renderGapReportMarkdown(r: GapReport): string {
  const lines: string[] = [];
  lines.push(`# What AI assistants say about ${r.company}`);
  lines.push("");
  lines.push(`Compared with the signed record for ${r.trooth_id} on ${r.ran_at}. Question set: ${r.kind}. Report id: ${r.id}.`);
  lines.push("");
  lines.push("## Assistants asked");
  lines.push("");
  for (const p of r.providers) {
    if (!p.configured) lines.push(`- ${p.label}: not configured (${p.reason ?? "no key"})`);
    else lines.push(`- ${p.label}: ${p.questions_asked} questions asked${p.errors ? `, ${p.errors} failed` : ""}${p.model ? `, model ${p.model}` : ""}`);
  }
  lines.push("");
  lines.push("## Counts by assistant");
  lines.push("");
  lines.push("| Assistant | Matches | Differs | Not answered | Not in the record | Cites only other sites | Cited the company's own site |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const p of r.providers) {
    if (!p.configured) continue;
    const t = r.totals[p.provider] ?? emptyTotals();
    const s = r.own_domain_citation_share[p.provider];
    lines.push(`| ${p.label} | ${t.matches} | ${t.differs} | ${t.not_answered} | ${t.unsupported_claim} | ${t.cites_third_party} | ${s ? `${s.cited_own_domain} of ${s.answers} answers` : "0 of 0 answers"} |`);
  }
  lines.push("");
  lines.push("## Corrections");
  lines.push("");
  if (!r.corrections.length) lines.push("No answer differed from the signed record in this run.");
  for (const c of r.corrections) {
    lines.push(`- ${PROVIDER_LABELS[c.provider]} was asked: ${c.question}`);
    lines.push(`  - It said: ${c.said}`);
    lines.push(`  - The signed record says: ${c.signed_statement}`);
    lines.push(`  - Fact ${c.fact_id}, source ${c.evidence_url}`);
  }
  lines.push("");
  lines.push("## Every finding");
  lines.push("");
  for (const f of r.findings) {
    lines.push(`- ${PROVIDER_LABELS[f.provider]} on "${f.question}" (${f.key}): ${WORDS[f.classification]}; citations: ${citationWords(f.citation)}`);
    if (f.said) lines.push(`  - Said: ${f.said}`);
    if (f.signed_statement) lines.push(`  - Signed: ${f.signed_statement}${f.provenance ? ` (${f.provenance})` : ""}`);
  }
  lines.push("");
  lines.push("Witnessed means Trooth observed it, with a source and a date, not that it is true. Trooth reports what each assistant said; it gives no company a number or a verdict.");
  return lines.join("\n");
}

function citationWords(c: Finding["citation"]): string {
  switch (c) {
    case "own_domain": return "the company's own site";
    case "trooth_network": return "the Trooth Network";
    case "neither": return "other sites only";
    case "none": return "none";
  }
}

// ------------------------------------------------------------------ the weekly run

/**
 * The one weekly schedule. wrangler.toml carries the same cron
 * (["15 * * * *", "30 1 * * *", "0 6 * * MON"]) and src/serve/routes.ts
 * runScheduled maps it to the weekly gap job; test/integration.test.ts fails
 * if the three disagree.
 */
export const WEEKLY_RUN = {
  /** Mondays at 06:00 UTC, before the US working day, so the report is in the inbox when it starts. The weekday is
   * a name: Cloudflare numbers weekdays from 1 = Sunday, so "0 6 * * 1" ran on Sundays (found 2026-10-26). */
  cron: "0 6 * * MON",
  hour_utc: 6,
  timezone: "UTC",
  kinds: ["b2b", "shopping", "local", "competitor"] as QuestionKind[],
  wranglerSnippet: '[triggers]\ncrons = ["15 * * * *", "30 1 * * *", "0 6 * * MON"]',
} as const;

export interface RunPlan {
  trooth_id: string;
  cron: string;
  timezone: "UTC";
  kinds: QuestionKind[];
  /** The next weekly run (Monday 06:00 UTC) after `from`. */
  next_run_at: string;
  /** Alert when the new report has more "differs" or "unsupported_claim" than the last one. */
  alert_on: Classification[];
}

export function nextWeeklyRun(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), WEEKLY_RUN.hour_utc, 0, 0, 0));
  const day = d.getUTCDay();
  let add = (1 - day + 7) % 7;
  if (add === 0 && d.getTime() <= from.getTime()) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

export function weeklyRunPlan(trooth_id: string, from: Date, kinds: QuestionKind[] = [...WEEKLY_RUN.kinds]): RunPlan {
  return { trooth_id, cron: WEEKLY_RUN.cron, timezone: "UTC", kinds, next_run_at: nextWeeklyRun(from).toISOString(), alert_on: ["differs", "unsupported_claim"] };
}

// ------------------------------------------------------------------ before and after

export interface FindingChange {
  provider: ProviderName;
  question_id: string;
  key: string;
  before: Classification | null;
  after: Classification | null;
}

export interface ReportDiff {
  before_id: string;
  after_id: string;
  before_ran_at: string;
  after_ran_at: string;
  /** Per provider, per classification: after count minus before count. */
  delta: Record<string, Record<Classification, number>>;
  /** Findings whose classification changed, appeared or disappeared. */
  changed: FindingChange[];
  /** Mismatches that became matches (differs or unsupported_claim before; matches or cites_third_party after). */
  resolved: FindingChange[];
  /** Matches that became mismatches. */
  regressed: FindingChange[];
  own_domain_citation_share: Record<string, { before: number; after: number }>;
}

const key = (f: Finding) => `${f.provider}|${f.question_id}|${f.key}`;
const GOOD: Classification[] = ["matches", "cites_third_party"];
const BAD: Classification[] = ["differs", "unsupported_claim"];

export function diffReports(before: GapReport, after: GapReport): ReportDiff {
  const providers = new Set([...Object.keys(before.totals), ...Object.keys(after.totals)]);
  const delta: ReportDiff["delta"] = {};
  const shares: ReportDiff["own_domain_citation_share"] = {};
  for (const p of providers) {
    const b = before.totals[p] ?? emptyTotals();
    const a = after.totals[p] ?? emptyTotals();
    delta[p] = emptyTotals();
    for (const c of CLASSIFICATIONS) delta[p]![c] = a[c] - b[c];
    shares[p] = { before: before.own_domain_citation_share[p]?.share ?? 0, after: after.own_domain_citation_share[p]?.share ?? 0 };
  }
  const bmap = new Map(before.findings.map((f) => [key(f), f]));
  const amap = new Map(after.findings.map((f) => [key(f), f]));
  const changed: FindingChange[] = [];
  for (const [k, bf] of bmap) {
    const af = amap.get(k);
    if (!af) changed.push({ provider: bf.provider, question_id: bf.question_id, key: bf.key, before: bf.classification, after: null });
    else if (af.classification !== bf.classification) changed.push({ provider: bf.provider, question_id: bf.question_id, key: bf.key, before: bf.classification, after: af.classification });
  }
  for (const [k, af] of amap) if (!bmap.has(k)) changed.push({ provider: af.provider, question_id: af.question_id, key: af.key, before: null, after: af.classification });
  const resolved = changed.filter((c) => c.before && BAD.includes(c.before) && c.after && GOOD.includes(c.after));
  const regressed = changed.filter((c) => c.before && GOOD.includes(c.before) && c.after && BAD.includes(c.after));
  return { before_id: before.id, after_id: after.id, before_ran_at: before.ran_at, after_ran_at: after.ran_at, delta, changed, resolved, regressed, own_domain_citation_share: shares };
}

export function renderDiffMarkdown(d: ReportDiff): string {
  const lines: string[] = [];
  lines.push(`# What changed between ${d.before_ran_at} and ${d.after_ran_at}`);
  lines.push("");
  lines.push("| Assistant | Matches | Differs | Not answered | Not in the record | Cites only other sites |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  for (const [p, t] of Object.entries(d.delta)) lines.push(`| ${PROVIDER_LABELS[p as ProviderName] ?? p} | ${sign(t.matches)} | ${sign(t.differs)} | ${sign(t.not_answered)} | ${sign(t.unsupported_claim)} | ${sign(t.cites_third_party)} |`);
  lines.push("");
  lines.push(`${d.resolved.length} mismatch${d.resolved.length === 1 ? "" : "es"} now match the signed record. ${d.regressed.length} answer${d.regressed.length === 1 ? "" : "s"} that matched before now differ.`);
  lines.push("");
  for (const c of d.changed) lines.push(`- ${PROVIDER_LABELS[c.provider]} on ${c.question_id} (${c.key}): ${c.before ?? "not asked"} to ${c.after ?? "not asked"}`);
  return lines.join("\n");
}
