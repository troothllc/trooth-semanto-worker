// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The free small-business view of the gap report: a company and up to three
// competitors, the local or shopping question set run against each, and a
// side-by-side a person can read on a phone. For each question: which
// companies the assistants mentioned, what they said, and whether the
// company's own site was cited. Plain words, mobile-first, one action link in
// blue (#1A73E8 on actions only, per the house style). No ranking, no number
// about any company: a count of mentions and citations is all it shows.

import { citationNote, sentences, mentions } from "./compare";
import { questionsFor, type Question, type QuestionParams } from "./prompts";
import { isAnswer, PROVIDER_LABELS, type AskResult, type ProviderAdapter, type ProviderName } from "./providers";

export interface CompanyRef {
  name: string;
  domain: string;
  products?: string[];
  service?: string;
}

export type CompetitorKind = "local" | "shopping";

/** One assistant's answer to one question asked about one company. */
export interface CompetitorRun {
  company: string;
  question: Question;
  results: AskResult[];
}

export interface CompanyCell {
  company: string;
  /** How many answers named this company. */
  mentioned_in: number;
  /** How many answers were given (configured providers that answered). */
  answers: number;
  /** The sentence that named the company, from the first answer that did. */
  what_they_said: string | null;
  /** How many answers cited this company's own site. */
  own_site_cited_in: number;
}

export interface CompetitorRow {
  template_id: string;
  question: string;
  cells: CompanyCell[];
}

export interface CompetitorView {
  object: "semanto.competitor_view";
  kind: CompetitorKind;
  company: CompanyRef;
  competitors: CompanyRef[];
  ran_at: string;
  providers_asked: ProviderName[];
  providers_not_configured: { provider: ProviderName; reason: string }[];
  rows: CompetitorRow[];
  /** Over all rows for the company itself. */
  summary: { questions: number; mentioned_in: number; own_site_cited_in: number; answers: number };
}

export const MAX_COMPETITORS = 3;

/** Ask the set about each company. Networked only through the adapters. */
export async function runCompetitorQuestions(kind: CompetitorKind, company: CompanyRef, competitors: CompanyRef[], adapters: ProviderAdapter[]): Promise<CompetitorRun[]> {
  if (competitors.length > MAX_COMPETITORS) throw new Error(`at most ${MAX_COMPETITORS} competitors`);
  const runs: CompetitorRun[] = [];
  for (const c of [company, ...competitors]) {
    const params: QuestionParams = { company: c.name, domain: c.domain, products: c.products ?? [], ...(c.service ? { service: c.service } : {}) };
    for (const q of questionsFor(kind, params)) {
      const results = await Promise.all(adapters.map((a) => a.ask(q.text)));
      runs.push({ company: c.name, question: q, results });
    }
  }
  return runs;
}

/** Pure: fold runs into the side-by-side. */
export function buildCompetitorView(kind: CompetitorKind, company: CompanyRef, competitors: CompanyRef[], runs: CompetitorRun[], ran_at: string): CompetitorView {
  if (competitors.length > MAX_COMPETITORS) throw new Error(`at most ${MAX_COMPETITORS} competitors`);
  const all = [company, ...competitors];
  const asked = new Set<ProviderName>();
  const notConfigured = new Map<ProviderName, string>();
  for (const r of runs) for (const x of r.results) {
    if (isAnswer(x)) asked.add(x.provider);
    else if ("configured" in x && x.configured === false) notConfigured.set(x.provider, x.reason);
  }
  const byTemplate = new Map<string, CompetitorRun[]>();
  for (const r of runs) {
    const list = byTemplate.get(r.question.template_id) ?? [];
    list.push(r);
    byTemplate.set(r.question.template_id, list);
  }
  const rows: CompetitorRow[] = [];
  for (const [template_id, list] of byTemplate) {
    const cells: CompanyCell[] = all.map((c) => {
      const mine = list.filter((r) => r.company === c.name);
      let mentioned_in = 0;
      let answers = 0;
      let own_site_cited_in = 0;
      let what: string | null = null;
      for (const r of mine) for (const x of r.results) {
        if (!isAnswer(x)) continue;
        answers += 1;
        const hit = sentences(x.answer_text).find((s) => mentions(s, [c.name]));
        if (hit) {
          mentioned_in += 1;
          what ??= hit;
        }
        if (citationNote(x.citations, [c.domain], "https://trooth.co") === "own_domain") own_site_cited_in += 1;
      }
      return { company: c.name, mentioned_in, answers, what_they_said: what, own_site_cited_in };
    });
    const first = list.find((r) => r.company === company.name) ?? list[0]!;
    rows.push({ template_id, question: genericQuestion(first.question.text, first.company), cells });
  }
  const own = rows.map((r) => r.cells[0]!);
  return {
    object: "semanto.competitor_view",
    kind,
    company,
    competitors,
    ran_at,
    providers_asked: [...asked],
    providers_not_configured: [...notConfigured].map(([provider, reason]) => ({ provider, reason })),
    rows,
    summary: {
      questions: rows.length,
      mentioned_in: own.reduce((n, c) => n + c.mentioned_in, 0),
      own_site_cited_in: own.reduce((n, c) => n + c.own_site_cited_in, 0),
      answers: own.reduce((n, c) => n + c.answers, 0),
    },
  };
}

/** "What are Acme Inc's opening hours?" becomes "What are this business's opening hours?" so one row reads for every company. */
function genericQuestion(text: string, company: string): string {
  return text.replace(new RegExp(`${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'s`, "g"), "this business's").replace(new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "this business");
}

// ------------------------------------------------------------------ rendering

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderCompetitorMarkdown(v: CompetitorView): string {
  const lines: string[] = [];
  lines.push(`# How AI assistants answer about ${v.company.name} and ${v.competitors.length} other${v.competitors.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(`Asked on ${v.ran_at}. Assistants: ${v.providers_asked.map((p) => PROVIDER_LABELS[p]).join(", ") || "none answered"}.`);
  if (v.providers_not_configured.length) lines.push(`Not asked: ${v.providers_not_configured.map((p) => `${PROVIDER_LABELS[p.provider]} (${p.reason})`).join("; ")}.`);
  lines.push("");
  lines.push(`Your business was named in ${v.summary.mentioned_in} of ${v.summary.answers} answers. Your own site was cited in ${v.summary.own_site_cited_in} of them.`);
  lines.push("");
  for (const r of v.rows) {
    lines.push(`## ${r.question}`);
    lines.push("");
    for (const c of r.cells) {
      const named = c.mentioned_in ? `named in ${c.mentioned_in} of ${c.answers} answers` : `not named in ${c.answers} answers`;
      const cited = c.own_site_cited_in ? `own site cited ${c.own_site_cited_in} time${c.own_site_cited_in === 1 ? "" : "s"}` : "own site not cited";
      lines.push(`- ${c.company}: ${named}; ${cited}.${c.what_they_said ? ` They said: "${c.what_they_said}"` : ""}`);
    }
    lines.push("");
  }
  lines.push("This shows what each assistant said, not whether it is right. Sign your record and the assistants get your words with a source.");
  return lines.join("\n");
}

/** Mobile-first HTML. Ink #202124 on Paper #F7F8F8, Open Sauce One, the one link in #1A73E8. */
export function renderCompetitorHtml(v: CompetitorView, actionUrl: string): string {
  const rows = v.rows
    .map((r) => {
      const cells = r.cells
        .map((c) => {
          const named = c.mentioned_in ? `Named in ${c.mentioned_in} of ${c.answers} answers.` : `Not named in ${c.answers} answers.`;
          const cited = c.own_site_cited_in ? `Own site cited ${c.own_site_cited_in} time${c.own_site_cited_in === 1 ? "" : "s"}.` : "Own site not cited.";
          const said = c.what_they_said ? `<p class="said">They said: ${esc(c.what_they_said)}</p>` : "";
          return `<li><strong>${esc(c.company)}</strong><p>${named} ${cited}</p>${said}</li>`;
        })
        .join("");
      return `<section><h2>${esc(r.question)}</h2><ul>${cells}</ul></section>`;
    })
    .join("");
  const notAsked = v.providers_not_configured.length ? `<p class="muted">Not asked: ${v.providers_not_configured.map((p) => esc(PROVIDER_LABELS[p.provider])).join(", ")}.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How AI assistants answer about ${esc(v.company.name)}</title>
<style>
  body { margin: 0; padding: 16px; background: #F7F8F8; color: #202124; font-family: "Open Sauce One", system-ui, sans-serif; font-size: 16px; line-height: 1.5; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 17px; margin: 24px 0 8px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { background: #ffffff; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
  li p { margin: 4px 0 0; }
  .said { color: #5f6368; }
  .muted { color: #5f6368; font-size: 14px; }
  a.action { display: inline-block; margin-top: 24px; color: #1A73E8; font-weight: 600; text-decoration: underline; }
</style>
</head>
<body>
<main>
<h1>How AI assistants answer about ${esc(v.company.name)}</h1>
<p>Your business was named in ${v.summary.mentioned_in} of ${v.summary.answers} answers. Your own site was cited in ${v.summary.own_site_cited_in} of them.</p>
<p class="muted">Asked on ${esc(v.ran_at)}. Assistants: ${esc(v.providers_asked.map((p) => PROVIDER_LABELS[p]).join(", ") || "none answered")}.</p>
${notAsked}
${rows}
<p>This shows what each assistant said, not whether it is right.</p>
<a class="action" href="${esc(actionUrl)}">Put your own words in front of them</a>
</main>
</body>
</html>`;
}
