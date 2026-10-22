// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen D, What Semanto read (step 4 of docs/audit/workflow-research.md
// section 5): the coverage receipt, modeled on Search Console's Page indexing
// report (counts in a row, then one row per reason with the page count, each
// opening to its pages with Open page and Copy address). While reading, a bar
// that moves on real counts (pages_done of found), Yoast's progress step and
// Plausible's progress banner. Semanto Basic stops here: Finish setup is the
// one blue button, and the card to sign as the company is outlined.

"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { LeftOutCode, ReadState } from "./types";
import { Alert, CopyButton, ErrorBox, LINK, OUTLINE, PLAIN, PRIMARY, ScreenHeading, StatusLine, cx } from "./ui";

export interface ScreenWhatWasReadProps {
  domain: string;
  read: ReadState;
  basic: boolean;
  /** Basic path chosen: setup is finished and the receipt stays as the record of what was read. */
  finished: boolean;
  onFinish(): Promise<void>;
  onUpgrade(): Promise<void>;
  onReadAgain(): Promise<void>;
  focusKey: string;
}

/** Section 5's order for the left-out reasons; codes the spec adds go after. */
const REASON_ORDER: LeftOutCode[] = ["noindex", "robots", "not_found", "server_error", "login", "duplicate", "too_large", "not_reached", "personal", "not_html", "other"];

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);

/** The basic notice, word for word from WITNESSED_NOT_SIGNED. */
export const BASIC_NOTICE = "This record is witnessed by Trooth and not signed by the company. Semanto Basic builds it from the public site; the company has not signed it.";

export function groupLeftOut(leftOut: ReadState["left_out"]): { code: LeftOutCode; reason: string; urls: string[] }[] {
  const by = new Map<LeftOutCode, { reason: string; urls: string[] }>();
  for (const p of leftOut) {
    const g = by.get(p.code) ?? { reason: p.reason, urls: [] };
    g.urls.push(p.url);
    by.set(p.code, g);
  }
  return [...by.entries()].sort((a, b) => REASON_ORDER.indexOf(a[0]) - REASON_ORDER.indexOf(b[0])).map(([code, g]) => ({ code, reason: g.reason, urls: g.urls }));
}

function eta(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (seconds < 60) return "less than a minute left";
  const m = Math.round(seconds / 60);
  return `about ${m} minute${m === 1 ? "" : "s"} left`;
}

export function ScreenWhatWasRead({ domain, read, basic, finished, onFinish, onUpgrade, onReadAgain, focusKey }: ScreenWhatWasReadProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | "finish" | "upgrade" | "again">(null);
  const [error, setError] = useState<unknown>(null);
  const groups = groupLeftOut(read.left_out);
  const done = read.status === "done";
  const failed = read.status === "failed";
  const partial = failed && read.pages_done > 0;
  const pct = read.found > 0 ? Math.min(100, Math.round((read.pages_done / read.found) * 100)) : 0;

  async function run(kind: "finish" | "upgrade" | "again", fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="screen-d-h" data-screen="D" className="flex flex-col gap-5">
      <ScreenHeading id="screen-d-h" focusKey={focusKey}>
        What Semanto read
      </ScreenHeading>

      {finished ? <StatusLine tone="done">{`Semanto Basic is set up for ${domain}. Trooth witnessed what it read, and looks again every day.`}</StatusLine> : null}

      {read.status === "queued" ? <StatusLine tone="idle">Semanto starts reading as soon as your domain is proved.</StatusLine> : null}

      {read.status === "reading" ? (
        <div className="flex flex-col gap-2">
          <StatusLine>
            {`Reading your site: ${fmt(read.pages_done)} of ${fmt(read.found)} pages. You can close this page. We will email you when it is done.`}
          </StatusLine>
          <div role="progressbar" aria-label="Pages read" aria-valuemin={0} aria-valuemax={read.found} aria-valuenow={read.pages_done} aria-valuetext={`${read.pages_done} of ${read.found} pages`} className="h-1.5 overflow-hidden rounded-full bg-hairline">
            <div className="h-full bg-text-primary transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </div>
          {eta(read.eta_seconds) ? <p className="text-[13px] tabular-nums text-text-muted">{eta(read.eta_seconds)}</p> : null}
        </div>
      ) : null}

      {failed && !partial ? <Alert title={read.error ?? `Semanto could not reach ${domain} after 3 tries. Your site may be down or blocking readers. Try again, or check that ${domain} opens in a browser.`} /> : null}
      {partial ? <StatusLine tone="attention">{`Stopped at ${fmt(read.pages_done)} of ${fmt(read.found)} pages.${read.error ? ` ${read.error}` : ""}`}</StatusLine> : null}

      {done || partial ? (
        <>
          <dl className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="What Semanto read">
            {[
              { k: "Found", v: read.found },
              { k: "Read", v: done ? read.read : read.pages_done },
              { k: "Left out", v: read.left_out.length },
            ].map((c) => (
              <div key={c.k} className="rounded-md border border-hairline bg-surface-1 px-3 py-3">
                <dt className="text-[13px] text-text-secondary">{c.k}</dt>
                <dd className="mt-0.5 text-[24px] font-normal tabular-nums text-text-primary">{fmt(c.v)}</dd>
              </div>
            ))}
          </dl>

          {groups.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-hairline">
              <h2 className="border-b border-hairline px-4 py-3 text-[15px] font-medium text-text-primary">Left out, and why</h2>
              <ul>
                {groups.map((g) => {
                  const isOpen = !!open[g.code];
                  return (
                    <li key={g.code} className="border-b border-hairline last:border-b-0" data-reason={g.code}>
                      <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="min-w-0 pt-2 text-[14px] text-text-primary sm:pt-0">{g.reason}</span>
                        <span className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                          <span className="text-[14px] tabular-nums text-text-secondary">
                            {fmt(g.urls.length)} page{g.urls.length === 1 ? "" : "s"}
                          </span>
                          <button type="button" className={PLAIN} aria-expanded={isOpen} aria-controls={`left-out-${g.code}`} aria-label={`${isOpen ? "Hide pages" : "See pages"}: ${g.reason}`} onClick={() => setOpen((o) => ({ ...o, [g.code]: !isOpen }))}>
                            {isOpen ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                            {isOpen ? "Hide pages" : "See pages"}
                          </button>
                        </span>
                      </div>
                      {isOpen ? (
                        <ul id={`left-out-${g.code}`} className="bg-surface-2 px-4 py-1">
                          {g.urls.map((u) => (
                            <li key={u} className="flex flex-col gap-1 border-b border-hairline py-2 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                              <span className="min-w-0 break-all font-mono text-[13px] text-text-primary">{u}</span>
                              <span className="flex shrink-0 items-center gap-2">
                                <a href={u} target="_blank" rel="noreferrer" className={LINK}>
                                  Open page
                                  <ExternalLink className="size-3.5" aria-hidden="true" />
                                </a>
                                <CopyButton value={u} label={`Copy address ${u}`} text="Copy address" />
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : done ? (
            <p className="text-[14px] text-text-secondary">Every page Semanto found was read.</p>
          ) : null}

        </>
      ) : null}

      {basic ? <p className="rounded-md border border-hairline bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-text-secondary">{BASIC_NOTICE}</p> : null}

      {error ? <ErrorBox error={error} /> : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {done && basic && !finished ? (
          <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => run("finish", onFinish)}>
            Finish setup
          </button>
        ) : null}
        {partial ? (
          <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => run("again", onReadAgain)}>
            Continue reading
          </button>
        ) : failed ? (
          <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => run("again", onReadAgain)}>
            Try again
          </button>
        ) : done ? (
          <button type="button" className={cx(PLAIN, "self-start sm:self-auto")} disabled={busy !== null} onClick={() => run("again", onReadAgain)}>
            Read again
          </button>
        ) : null}
      </div>

      {done && basic ? (
        <section aria-labelledby="upgrade-h" className="rounded-md border border-hairline px-4 py-4">
          <h2 id="upgrade-h" className="text-[15px] font-medium text-text-primary">
            Next: sign it as your company
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-text-secondary">
            <li>Today the record is witnessed by Trooth. Signing adds your company&apos;s own signature, so anyone can check the words came from you.</li>
            <li>Your site serves the signed copy to AI readers that ask for markdown.</li>
            <li>Trooth asks AI assistants about you and tells you when an answer differs from your site.</li>
          </ul>
          <button type="button" className={cx(OUTLINE, "mt-3")} disabled={busy !== null} onClick={() => run("upgrade", onUpgrade)}>
            Sign it as your company
          </button>
        </section>
      ) : null}
    </section>
  );
}
