// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen F, Put it on your site (steps 7, 8 and 9 of
// docs/audit/workflow-research.md section 5). The host is the one the API
// detected or the owner chose, said in one sentence with a Change link
// (Certbot's host picker, Vercel's automatic method choice); only that host's
// guide shows, chosen by guide_id, at most four lines and one action
// (Plausible's per-host guides, Site Kit, Shopify's app embed). "Check my
// site" runs the API's three checks and shows each with the API's own plain
// message. Then monitoring: suggested questions and companies to compare
// (Peec, Otterly), and Start monitoring. Blue moves with the owner: the
// guide's action first, then Check my site, then Start monitoring.

"use client";

import { useState } from "react";
import { Check, Circle, ExternalLink, Plus, X } from "lucide-react";
import { cleanDomain } from "./domain";
import { GUIDE_IDS, HOST_CHOICES, HOST_NAMES, guideFor } from "./guides";
import type { CheckState, Competitor, HostKind, InstallCheckAnswer, InstallState, MonitoringState } from "./types";
import { CopyButton, ErrorBox, FOCUS, LINK, OUTLINE, PLAIN, PRIMARY, ScreenHeading, StatusLine, ValueRow, cx } from "./ui";

export interface ScreenInstallProps {
  domain: string;
  troothId: string;
  /** https://api.trooth.co, for the values to paste. */
  apiBase: string;
  install: InstallState;
  monitoring: MonitoringState;
  /** Step done: all three checks passed and monitoring started. */
  done: boolean;
  /** Where each guide's link goes, keyed by guide_id. */
  guideLinks: Partial<Record<string, string>>;
  handoffHref: string;
  monitoringHref: string;
  onChangeHost(host: HostKind): Promise<void>;
  onCheck(): Promise<InstallCheckAnswer>;
  onStartMonitoring(body: { questions: string[]; competitors: Competitor[] }): Promise<void>;
  focusKey: string;
}

/** Section 5's check labels; the third is the API's well_known check (section 5's "Trooth can reach" is folded into the markdown check's message by the API). */
export const CHECK_LABELS: { key: "markdown" | "signature" | "well_known"; label: (domain: string) => string }[] = [
  { key: "markdown", label: () => "Your site answers markdown when asked (Accept: text/markdown)" },
  { key: "signature", label: () => "The signature on what your site sends matches what you signed" },
  { key: "well_known", label: () => "Your site serves the two /.well-known files exactly as Trooth holds them" },
];

const MAX_QUESTIONS = 10;
const MAX_COMPANIES = 3;

function CheckGlyph({ state }: { state: CheckState }) {
  if (state === "pass") return <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" />;
  if (state === "fail") return <X className="mt-0.5 size-4 shrink-0 text-ink-emphasis" aria-hidden="true" />;
  return <Circle className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />;
}

const STATE_WORD: Record<CheckState, string> = { pass: "Passed.", fail: "Not yet.", pending: "Not checked yet." };

const same = (a: string, b: string) => a.replace(/\.$/, "").trim().toLowerCase() === b.replace(/\.$/, "").trim().toLowerCase();

/** Under each check: the API's message when it says something the label does not, else the state in a word. */
function rowNote(state: CheckState, message: string | undefined, label: string): string {
  if (state === "pending" || !message || same(message, label)) return STATE_WORD[state];
  return message;
}

export function ScreenInstall(p: ScreenInstallProps) {
  const { domain, install, monitoring } = p;
  const [picking, setPicking] = useState(install.host === "unknown");
  const [guideDone, setGuideDone] = useState(false);
  const [answer, setAnswer] = useState<InstallCheckAnswer | null>(null);
  const [busy, setBusy] = useState<null | "host" | "check" | "monitor">(null);
  const [error, setError] = useState<unknown>(null);
  const [questions, setQuestions] = useState<string[]>(() => (monitoring.questions.length ? monitoring.questions : monitoring.suggested_questions).slice(0, MAX_QUESTIONS));
  const [newQuestion, setNewQuestion] = useState("");
  const [companies, setCompanies] = useState<Competitor[]>(() => monitoring.competitors.slice(0, MAX_COMPANIES));
  const [newCompany, setNewCompany] = useState({ name: "", domain: "" });
  const [companyError, setCompanyError] = useState<string | null>(null);

  const guideId = install.guide_id || GUIDE_IDS[install.host];
  const guide = install.host === "unknown" ? null : guideFor(guideId, { troothId: p.troothId, domain, apiBase: p.apiBase, links: p.guideLinks });
  const checks = answer?.checks ?? install.checks;
  const checked = answer !== null || install.checked_at !== null;
  const allPass = checks.markdown === "pass" && checks.signature === "pass" && checks.well_known === "pass";
  const started = monitoring.started_at !== null;
  const guideIsPrimary = !guideDone && !checked;

  async function run<T>(kind: "host" | "check" | "monitor", fn: () => Promise<T>): Promise<T | null> {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    const a = await run("check", p.onCheck);
    if (a) setAnswer(a);
  }

  function addQuestion(e: { preventDefault(): void }) {
    e.preventDefault();
    const q = newQuestion.trim();
    if (!q || questions.length >= MAX_QUESTIONS || questions.includes(q)) return;
    setQuestions((qs) => [...qs, q]);
    setNewQuestion("");
  }

  function addCompany(e: { preventDefault(): void }) {
    e.preventDefault();
    const name = newCompany.name.trim();
    const d = cleanDomain(newCompany.domain);
    if (!name) return setCompanyError("Type the company's name.");
    if (!d.ok) return setCompanyError(d.message);
    if (companies.length >= MAX_COMPANIES) return setCompanyError("Up to three companies.");
    setCompanyError(null);
    setCompanies((cs) => [...cs, { name, domain: d.domain }]);
    setNewCompany({ name: "", domain: "" });
  }

  if (p.done) {
    return (
      <section aria-labelledby="screen-f-h" data-screen="F" className="flex flex-col gap-5">
        <ScreenHeading id="screen-f-h" focusKey={`${p.focusKey}-done`}>
          Put it on your site
        </ScreenHeading>
        <StatusLine tone="done">{`${domain} is serving your signed Semanto record.`}</StatusLine>
        <p className="text-[15px] leading-relaxed text-text-secondary">
          Semanto is asking AI assistants your {questions.length} questions. First answers usually take a few minutes; we will email you. Trooth emails you when an assistant says something different from your site.
        </p>
        <a href={p.monitoringHref} className={cx(PRIMARY, "self-start")}>
          Open monitoring
        </a>
      </section>
    );
  }

  return (
    <section aria-labelledby="screen-f-h" data-screen="F" className="flex flex-col gap-5">
      <ScreenHeading id="screen-f-h" focusKey={p.focusKey}>
        Put it on your site
      </ScreenHeading>

      <div className="flex flex-col gap-2">
        {install.host === "unknown" ? (
          <p className="text-[15px] text-text-primary">We could not tell where your site runs. Pick it from the list.</p>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-[15px] text-text-primary" data-testid="host-sentence" data-host={install.host}>
            <span>
              Your site runs on <strong className="font-medium">{HOST_NAMES[install.host]}</strong>.
            </span>
            <button type="button" className={LINK} aria-expanded={picking} aria-controls="host-list" onClick={() => setPicking((v) => !v)}>
              Change
            </button>
          </p>
        )}
        {picking ? (
          <ul id="host-list" aria-label="Where your site runs" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {HOST_CHOICES.map((h) => (
              <li key={h.host}>
                <button
                  type="button"
                  aria-pressed={install.host === h.host}
                  disabled={busy !== null}
                  className={cx(OUTLINE, "w-full", install.host === h.host && "font-medium")}
                  onClick={async () => {
                    await run("host", () => p.onChangeHost(h.host));
                    setPicking(false);
                    setGuideDone(false);
                  }}
                >
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {guide && !allPass ? (
        <div className="flex flex-col gap-3 rounded-md border border-hairline px-4 py-4" data-guide={guide.id}>
          <div onClickCapture={() => setGuideDone(true)} className="flex flex-col items-start gap-2">
            {guide.primary.kind === "link" ? (
              <a href={guide.primary.href} target="_blank" rel="noreferrer" className={guideIsPrimary ? PRIMARY : OUTLINE}>
                {guide.primary.label}
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            ) : (
              <CopyButton value={guide.primary.value} label={guide.primary.label} text={guide.primary.label} primary={guideIsPrimary} />
            )}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-text-secondary">
            {guide.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
          {guide.values.length ? (
            <div className="rounded-md border border-hairline px-3">
              {guide.values.map((v) => (
                <ValueRow key={v.label} label={v.label} value={v.value} block={v.block} />
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-4">
            {guide.alternative ? (
              <a href={guide.alternative.href} target="_blank" rel="noreferrer" className={LINK}>
                {guide.alternative.label}
              </a>
            ) : null}
            <a href={p.handoffHref} className={LINK}>
              Send to my developer
            </a>
          </div>
        </div>
      ) : null}

      {install.host !== "unknown" ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-[15px] font-medium text-text-primary">Check it works</h2>
          <ul className="flex flex-col gap-2" aria-label="Install checks">
            {CHECK_LABELS.map((c) => (
              <li key={c.key} className="flex items-start gap-2 rounded-md border border-hairline px-3 py-2.5" data-check={c.key} data-state={checks[c.key]}>
                <CheckGlyph state={checks[c.key]} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-text-primary">{c.label(domain)}</span>
                  <span className="block text-[13px] text-text-secondary">{rowNote(checks[c.key], answer?.messages[c.key], c.label(domain))}</span>
                </span>
              </li>
            ))}
          </ul>
          <div role="status" aria-live="polite" className="text-[14px] text-text-secondary">
            {busy === "check" ? `Checking ${domain}` : allPass ? (answer?.message ?? install.message) : null}
          </div>
          {!allPass ? (
            <button type="button" className={cx(guideIsPrimary ? OUTLINE : PRIMARY, "self-start")} disabled={busy !== null} onClick={check}>
              {checked ? "Check again" : "Check my site"}
            </button>
          ) : (
            <button type="button" className={cx(PLAIN, "self-start")} disabled={busy !== null} onClick={check}>
              Check again
            </button>
          )}
        </div>
      ) : null}

      {error ? <ErrorBox error={error} /> : null}

      {allPass && !started ? (
        <div className="flex flex-col gap-5 border-t border-hairline pt-5">
          <section aria-labelledby="questions-h" className="flex flex-col gap-2">
            <h2 id="questions-h" className="text-[15px] font-medium text-text-primary">
              Questions Semanto will ask AI assistants about you
            </h2>
            <ul className="flex flex-col">
              {questions.map((q) => (
                <li key={q} className="flex items-center justify-between gap-2 border-b border-hairline py-1 last:border-b-0">
                  <span className="min-w-0 text-[14px] text-text-primary">{q}</span>
                  <button type="button" className={PLAIN} aria-label={`Remove question: ${q}`} onClick={() => setQuestions((qs) => qs.filter((x) => x !== q))}>
                    <X className="size-4" aria-hidden="true" />
                    <span aria-hidden="true">Remove</span>
                  </button>
                </li>
              ))}
            </ul>
            {questions.length < MAX_QUESTIONS ? (
              <form onSubmit={addQuestion} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1">
                  <label htmlFor="setup-new-question" className="text-[13px] font-medium text-text-secondary">
                    New question
                  </label>
                  <input id="setup-new-question" value={newQuestion} onChange={(e: { target: { value: string } }) => setNewQuestion(e.target.value)} className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[14px] text-text-primary", FOCUS)} />
                </div>
                <button type="submit" className={OUTLINE}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add a question
                </button>
              </form>
            ) : null}
          </section>

          <section aria-labelledby="companies-h" className="flex flex-col gap-2">
            <h2 id="companies-h" className="text-[15px] font-medium text-text-primary">
              Companies to compare
            </h2>
            {companies.length === 0 ? <p className="text-[14px] text-text-secondary">Up to three. Optional.</p> : null}
            <ul className="flex flex-col">
              {companies.map((c) => (
                <li key={c.domain} className="flex items-center justify-between gap-2 border-b border-hairline py-1 last:border-b-0">
                  <span className="min-w-0 text-[14px] text-text-primary">
                    {c.name} <span className="text-text-muted">{c.domain}</span>
                  </span>
                  <button type="button" className={PLAIN} aria-label={`Remove company: ${c.name}`} onClick={() => setCompanies((cs) => cs.filter((x) => x.domain !== c.domain))}>
                    <X className="size-4" aria-hidden="true" />
                    <span aria-hidden="true">Remove</span>
                  </button>
                </li>
              ))}
            </ul>
            {companies.length < MAX_COMPANIES ? (
              <form onSubmit={addCompany} noValidate className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1">
                  <label htmlFor="setup-company-name" className="text-[13px] font-medium text-text-secondary">
                    Company name
                  </label>
                  <input id="setup-company-name" value={newCompany.name} onChange={(e: { target: { value: string } }) => setNewCompany((c) => ({ ...c, name: e.target.value }))} className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[14px] text-text-primary", FOCUS)} />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <label htmlFor="setup-company-site" className="text-[13px] font-medium text-text-secondary">
                    Website
                  </label>
                  <input id="setup-company-site" placeholder="example.com" value={newCompany.domain} onChange={(e: { target: { value: string } }) => setNewCompany((c) => ({ ...c, domain: e.target.value }))} className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[14px] text-text-primary", FOCUS)} />
                </div>
                <button type="submit" className={OUTLINE}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add a company
                </button>
              </form>
            ) : null}
            {companyError ? <p className="text-[13px] text-text-primary">{companyError}</p> : null}
          </section>

          {busy === "monitor" ? <StatusLine>{`Asking AI assistants your first ${questions.length} questions. First answers usually take a few minutes; we will email you.`}</StatusLine> : null}
          <button type="button" className={cx(PRIMARY, "self-start")} disabled={busy !== null || questions.length === 0} onClick={() => run("monitor", () => p.onStartMonitoring({ questions, competitors: companies }))}>
            Start monitoring
          </button>
        </div>
      ) : null}
    </section>
  );
}
