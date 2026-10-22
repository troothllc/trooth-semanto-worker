// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen C, Prove you control the domain (step 3 of
// docs/audit/workflow-research.md section 5). The record name and value with
// Copy buttons, the steps for the DNS host read from NS records, Domain
// Connect's one-click button only when the API answers domain_connect_url,
// and a status line that moves from waiting to found to proved on its own:
// the wizard's poll is the check (Postmark's records turn green by
// themselves; Search Console's provider picker; Resend's Auto configure).
// The status words are the server's (src/setup/dns-diagnosis.ts), which keep
// the word "proven" for a domain.

"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, Download, ExternalLink } from "lucide-react";
import { DNS_HOSTS, stepsForHost } from "./dns-guides";
import type { ProofState, ReadState } from "./types";
import { CopyButton, ErrorBox, FOCUS, LINK, OUTLINE, PRIMARY, ScreenHeading, StatusLine, cx } from "./ui";

export interface ScreenProveDomainProps {
  domain: string;
  proof: ProofState;
  read: ReadState | null;
  /** The owner pressed "I've added it": show the looking line and read again at once. */
  onAdded(): void;
  /** A plain "Check now": one more read of the state at once. */
  onCheckNow(): void;
  onLookAgain(): Promise<void>;
  /** "I will do this later": saves the step on the server. */
  onLater(): Promise<void>;
  /** The developer handoff: a signed link to send to whoever manages the domain. */
  handoffHref: string;
  /** Set when the owner came back from the DNS provider having cancelled there. */
  domainConnectDeclined?: boolean;
  focusKey: string;
}

type Tab = "dns" | "file";

export function ScreenProveDomain({ domain, proof, read, onAdded, onCheckNow, onLookAgain, onLater, handoffHref, domainConnectDeclined, focusKey }: ScreenProveDomainProps) {
  const oneClick = proof.provider.domain_connect_url;
  const [manual, setManual] = useState(!oneClick);
  const [told, setTold] = useState(false);
  const [tab, setTab] = useState<Tab>("dns");
  const [otherHost, setOtherHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [laterSaved, setLaterSaved] = useState(false);
  const [checks, setChecks] = useState(0);
  const proved = proof.status === "found" || proof.status === "proved" || proof.diagnosis.state === "proven";
  const d = proof.diagnosis;

  // "A plain Check now link appears after the first check": count the server's lookups seen here.
  useEffect(() => {
    if (proof.checked_at) setChecks((n) => n + 1);
  }, [proof.checked_at]);

  const steps = otherHost ? stepsForHost(otherHost, proof.name_to_type, proof.record_name, domain) : proof.provider.manual_steps;
  const hostName = otherHost ? (DNS_HOSTS.find((h) => h.id === otherHost)?.name ?? "your DNS host") : proof.provider.name;

  // The status line: the words for the moment, never a guess.
  let status: { text: string; detail?: string; fix?: string; tone: "working" | "done" | "attention" | "idle" };
  if (proved) status = { text: `You proved control of ${domain}. Keep the record in place: Trooth looks again every day.`, tone: "done" };
  else if (domainConnectDeclined && !told) status = { text: `You cancelled at ${proof.provider.name}. Nothing was changed. Try again, or add it yourself.`, tone: "attention" };
  else if (d.state === "looking" || d.state === "not_started") status = told ? { text: d.state === "looking" ? d.title : "Looking for your record", detail: d.state === "looking" ? d.detail : "Most hosts publish a new record within minutes. You can leave this page: Trooth keeps looking and emails you when it is found.", tone: "working" } : { text: "Add the record. Trooth looks for it on its own.", tone: "idle" };
  else status = { text: d.title, detail: d.detail, ...(d.fix ? { fix: d.fix } : {}), tone: d.tone === "attention" || d.tone === "stopped" ? "attention" : "working" };

  const rowState = proved ? "found" : proof.status === "found_wrong_value" ? "wrong" : "waiting";
  const timedOut = d.state === "timed_out";
  const readStarted = read && read.held && (read.status === "queued" || read.status === "reading");

  const recordTable = (
        <div className="overflow-hidden rounded-md border border-hairline">
          <table className="w-full table-fixed text-left text-[14px]">
            <caption className="sr-only">The DNS record to add</caption>
            <colgroup>
              <col className="w-[64px] sm:w-[96px]" />
              <col />
            </colgroup>
            <tbody>
              <tr className="border-b border-hairline">
                <th scope="row" className="px-3 py-3 align-top text-[13px] font-medium text-text-secondary">
                  Type
                </th>
                <td className="px-3 py-3 font-mono text-text-primary">{proof.record_type}</td>
              </tr>
              <tr className="border-b border-hairline">
                <th scope="row" className="px-3 py-3 align-top text-[13px] font-medium text-text-secondary">
                  Name
                </th>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-text-primary">{proof.name_to_type}</p>
                      <p className="mt-1 text-[13px] text-text-secondary">
                        Some hosts want only <span className="font-mono">{proof.name_to_type}</span>; others want <span className="break-all font-mono">{proof.record_name}</span>. Try the first.
                      </p>
                    </div>
                    <CopyButton value={proof.name_to_type} label="Copy record name" />
                  </div>
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-3 py-3 align-top text-[13px] font-medium text-text-secondary">
                  Value
                </th>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <p className="min-w-0 break-all font-mono text-text-primary">{proof.record_value}</p>
                    <CopyButton value={proof.record_value} label="Copy record value" />
                  </div>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-text-secondary" data-testid="record-row-state" data-state={rowState}>
                    {rowState === "found" ? <Check className="size-3.5 text-text-primary" aria-hidden="true" /> : <Circle className="size-3.5" aria-hidden="true" />}
                    {rowState === "found" ? "Found" : rowState === "wrong" ? "Found, but the value does not match" : "Not found yet"}
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
  );

  const added = () => {
    setTold(true);
    onAdded();
  };

  return (
    <section aria-labelledby="screen-c-h" data-screen="C" className="flex flex-col gap-5">
      <ScreenHeading id="screen-c-h" focusKey={focusKey}>
        {`Prove you control ${domain}`}
      </ScreenHeading>
      {readStarted ? <p className="text-[14px] text-text-secondary">Semanto has started reading your site. Keep going.</p> : null}

      <div className="rounded-md border border-hairline bg-surface-1 px-4 py-3" data-testid="proof-status" data-status={proof.status}>
        <p className="flex items-start gap-2">
          {proved ? <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" /> : status.tone === "attention" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ink-emphasis" aria-hidden="true" /> : <Circle className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />}
          <span className="min-w-0 flex-1">
            <StatusLine tone={status.tone}>
              <span className="font-medium text-text-primary">{status.text}</span>
              {status.detail ? <span className="block">{status.detail}</span> : null}
              {status.fix ? <span className="block font-medium text-text-primary">{status.fix}</span> : null}
            </StatusLine>
          </span>
        </p>
      </div>

      {oneClick && !manual && !proved ? (
        <div className="flex flex-col gap-3">
          <p className="text-[15px] leading-relaxed text-text-secondary">
            Your domain&apos;s DNS is at {proof.provider.name}. Trooth can add the record for you. You will sign in at {proof.provider.name} and approve two records. Nothing else changes.
          </p>
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <a href={oneClick} className={PRIMARY}>
              {`Add it at ${proof.provider.name}`}
            </a>
            <button type="button" className={LINK} onClick={() => setManual(true)}>
              I&apos;ll add it myself
            </button>
            <a href={handoffHref} className={LINK}>
              Send these steps to the person who manages our domain
            </a>
          </div>
        </div>
      ) : null}

      {proved ? recordTable : null}

      {manual && !proved ? (
        <div className="flex flex-col gap-4">
          <div role="tablist" aria-label="How to prove control" className="flex gap-1 border-b border-hairline">
            {(["dns", "file"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`proof-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`proof-panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e: { key: string }) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") setTab(tab === "dns" ? "file" : "dns");
                }}
                className={cx("-mb-px min-h-[44px] border-b-2 px-3 text-[14px]", tab === t ? "border-text-primary font-medium text-text-primary" : "border-transparent text-text-secondary", FOCUS)}
              >
                {t === "dns" ? "Add a DNS record" : "Upload a file instead"}
              </button>
            ))}
          </div>

          {tab === "dns" ? (
            <div id="proof-panel-dns" role="tabpanel" aria-labelledby="proof-tab-dns" className="flex flex-col gap-4">
              {recordTable}

              <div>
                <h2 className="text-[15px] font-medium text-text-primary">{otherHost ? `Steps for ${hostName}` : `Your domain's DNS is at ${hostName}`}</h2>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-text-secondary">
                  {steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <details className="mt-2">
                  <summary className={cx(LINK, "cursor-pointer")}>Not your host?</summary>
                  <div className="mt-2 flex flex-col gap-1.5">
                    <label htmlFor="proof-other-host" className="text-[13px] font-medium text-text-secondary">
                      Where is your domain&apos;s DNS?
                    </label>
                    <select
                      id="proof-other-host"
                      value={otherHost ?? ""}
                      onChange={(e: { target: { value: string } }) => setOtherHost(e.target.value || null)}
                      className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[14px] text-text-primary sm:w-auto", FOCUS)}
                    >
                      <option value="">{proof.provider.name} (what Trooth found)</option>
                      {DNS_HOSTS.filter((h) => h.id !== proof.provider.id).map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </details>
              </div>
            </div>
          ) : (
            <div id="proof-panel-file" role="tabpanel" aria-labelledby="proof-tab-file" className="flex flex-col gap-3">
              <p className="text-[14px] leading-relaxed text-text-secondary">For owners who cannot reach DNS: put this file on your site, at this address. Trooth looks for it the same way.</p>
              <div className="rounded-md border border-hairline px-3">
                <div className="flex flex-col gap-2 border-b border-hairline py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text-secondary">File name</p>
                    <p className="break-all font-mono text-[14px] text-text-primary">/.well-known/trooth-claim.txt</p>
                  </div>
                  <CopyButton value="/.well-known/trooth-claim.txt" label="Copy file name" />
                </div>
                <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text-secondary">Contents</p>
                    <p className="break-all font-mono text-[14px] text-text-primary">{proof.well_known.body}</p>
                  </div>
                  <CopyButton value={proof.well_known.body} label="Copy file contents" />
                </div>
              </div>
              <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(proof.well_known.body)}`} download="trooth-claim.txt" className={cx(OUTLINE, "self-start")}>
                <Download className="size-4" aria-hidden="true" />
                Download the file
              </a>
              <a href={proof.well_known.url} target="_blank" rel="noreferrer" className={LINK}>
                Open {proof.well_known.url}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          )}

          {error ? <ErrorBox error={error} /> : null}

          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            {timedOut ? (
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await onLookAgain();
                    setTold(true);
                  } catch (err) {
                    setError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Look again
              </button>
            ) : !told ? (
              <button type="button" className={PRIMARY} onClick={added}>
                I&apos;ve added it
              </button>
            ) : null}
            {told && checks > 0 && !timedOut ? (
              <button type="button" className={LINK} onClick={onCheckNow}>
                Check now
              </button>
            ) : null}
            {oneClick ? (
              <button type="button" className={LINK} onClick={() => setManual(false)}>
                {`Use one click at ${proof.provider.name} instead`}
              </button>
            ) : (
              <a href={handoffHref} className={LINK}>
                Send these steps to the person who manages our domain
              </a>
            )}
          </div>
        </div>
      ) : null}

      {!proved ? (
        <div className="flex flex-col gap-1 border-t border-hairline pt-4">
          {laterSaved ? (
            <StatusLine tone="done">Saved. You can close this page. Trooth keeps looking for 72 hours and emails you when it finds the record.</StatusLine>
          ) : (
            <button
              type="button"
              className={cx(LINK, "self-start")}
              onClick={async () => {
                try {
                  await onLater();
                  setLaterSaved(true);
                } catch (err) {
                  setError(err);
                }
              }}
            >
              I will do this later
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
