// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// GapReportPanel: what AI providers said about the company when asked the
// buyer prompts, compared with the signed record. Per provider: whether it is
// configured, counts by classification; then the corrections list with a link
// to the signed source for each, and a before-and-after strip. Counts come
// from the parent; nothing here is a measurement the panel makes itself.

"use client";

import { ExternalLink } from "lucide-react";
import { fmtCount, fmtDate } from "./format";

/** How one provider answer compares with the signed record: src/gap/compare.ts Classification. */
export type Classification = "matches" | "differs" | "not_answered" | "unsupported_claim" | "cites_third_party";

export const CLASSIFICATION_TEXT: Record<Classification, string> = {
  matches: "Matches what you signed",
  differs: "Says something different",
  not_answered: "Left it out",
  unsupported_claim: "States something you have not published",
  cites_third_party: "Matches, but took it from someone else",
};

/** src/gap/report.ts ProviderSummary plus that provider's row of the totals. */
export interface ProviderSummary {
  provider: string;
  /** The provider's name as the product shows it. */
  label: string;
  /** False when no key is set for this provider; its row says why instead of showing zeros. */
  configured: boolean;
  reason?: string;
  questions_asked: number;
  errors: number;
  model?: string;
  counts: Record<Classification, number>;
}

/** src/gap/report.ts Correction. */
export interface Correction {
  id: string;
  provider: string;
  question: string;
  said: string;
  signed_statement: string;
  fact_id: string;
  /** The page the signed fact came from, with its anchor when there is one. */
  evidence_url: string;
}

export interface GapCounts {
  matches: number;
  differs: number;
  not_answered: number;
}

export interface GapReportPanelProps {
  report_date: string | null;
  providers: ProviderSummary[];
  corrections: Correction[];
  /** Counts from the report before this one and from this one, when there is an earlier one. */
  before_after: { before: GapCounts; before_date: string; after: GapCounts; after_date: string } | null;
}

const COUNT_ORDER: Classification[] = ["matches", "differs", "not_answered", "unsupported_claim", "cites_third_party"];

function Strip({ label, date, counts }: { label: string; date: string; counts: GapCounts }) {
  const total = counts.matches + counts.differs + counts.not_answered;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  return (
    <div>
      <p className="text-[13px] text-text-secondary">
        {label} <span className="text-text-primary">{fmtDate(date)}</span>
      </p>
      <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-paper" role="img" aria-label={`${counts.matches} match, ${counts.differs} differ, ${counts.not_answered} left out`}>
        <span className="h-full bg-ink" style={{ width: `${pct(counts.matches)}%` }} />
        <span className="h-full bg-ink-emphasis" style={{ width: `${pct(counts.differs)}%` }} />
        <span className="h-full bg-hairline" style={{ width: `${pct(counts.not_answered)}%` }} />
      </div>
      <p className="mt-1 text-[12.5px] tabular-nums text-text-secondary">
        {fmtCount(counts.matches)} match, {fmtCount(counts.differs)} differ, {fmtCount(counts.not_answered)} left out
      </p>
    </div>
  );
}

export function GapReportPanel({ report_date, providers, corrections, before_after }: GapReportPanelProps) {
  const configured = providers.filter((p) => p.configured);
  return (
    <section aria-labelledby="gap-title" className="rounded-md border border-hairline">
      <div className="border-b border-hairline px-5 py-4">
        <h2 id="gap-title" className="text-[15px] font-medium text-text-primary">
          What AI says about you, next to what you signed
        </h2>
        <p className="mt-1 text-[13px] text-text-secondary">
          {report_date ? `Report of ${fmtDate(report_date)}. ` : "No report yet. "}
          {configured.length === 0 ? "No provider is set up, so nothing was asked." : `${configured.length} of ${providers.length} providers set up.`}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-hairline text-left text-[12.5px] text-text-secondary">
              <th scope="col" className="px-5 py-2 font-medium">
                Provider
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Asked
              </th>
              {COUNT_ORDER.map((c) => (
                <th key={c} scope="col" className="px-3 py-2 font-medium">
                  {CLASSIFICATION_TEXT[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.provider} className="border-b border-hairline last:border-b-0">
                <th scope="row" className="px-5 py-2 text-left font-normal text-text-primary">
                  {p.label}
                  {p.model ? <span className="block text-[12px] text-text-secondary">{p.model}</span> : null}
                </th>
                {p.configured ? (
                  <>
                    <td className="px-3 py-2 tabular-nums text-text-primary">
                      {fmtCount(p.questions_asked)}
                      {p.errors > 0 ? <span className="block text-[12px] text-text-secondary">{fmtCount(p.errors)} did not answer</span> : null}
                    </td>
                    {COUNT_ORDER.map((c) => (
                      <td key={c} className="px-3 py-2 tabular-nums text-text-primary">
                        {fmtCount(p.counts[c])}
                      </td>
                    ))}
                  </>
                ) : (
                  <td colSpan={COUNT_ORDER.length + 1} className="px-3 py-2 text-text-secondary">
                    {p.reason ?? "Not set up. Add a key for this provider to include it."}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {before_after ? (
        <div className="grid grid-cols-1 gap-4 border-t border-hairline px-5 py-4 sm:grid-cols-2">
          <Strip label="Before" date={before_after.before_date} counts={before_after.before} />
          <Strip label="After" date={before_after.after_date} counts={before_after.after} />
        </div>
      ) : null}

      <div className="border-t border-hairline px-5 py-4">
        <h3 className="text-[13.5px] font-medium text-text-primary">Corrections</h3>
        {corrections.length === 0 ? (
          <p className="mt-1 text-[13px] text-text-secondary">{report_date ? "Nothing to correct in this report." : "Corrections appear here after the first report."}</p>
        ) : (
          <ul className="mt-2 divide-y divide-hairline">
            {corrections.map((c) => (
              <li key={c.id} className="py-3">
                <p className="text-[13px] text-text-secondary">
                  {c.provider} was asked: <span className="text-text-primary">{c.question}</span>
                </p>
                <dl className="mt-1 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-text-secondary">It said</dt>
                  <dd className="text-text-primary">{c.said}</dd>
                  <dt className="text-text-secondary">You signed</dt>
                  <dd className="text-text-primary">{c.signed_statement}</dd>
                </dl>
                <a href={c.evidence_url} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-text-secondary underline underline-offset-2 hover:text-text-primary">
                  Signed source
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
