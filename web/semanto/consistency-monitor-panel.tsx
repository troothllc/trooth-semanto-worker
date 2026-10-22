// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// ConsistencyMonitorPanel: where a public surface says something different
// from the signed record. Mismatches are grouped by severity, each row shows
// the signed value, the surface value and one action, the way Google Search
// Console's issue reports and Sentry's issue list put the fix next to the
// finding. Plain data in; the parent fetches.

"use client";

import { ArrowRight } from "lucide-react";
import { fmtDateTime, SEVERITY_TEXT, SURFACE_TEXT } from "./format";

/** src/monitor/types.ts Severity: trust (Google compares it), visibility (structured data absent), note (everything else). */
export type Severity = "trust" | "visibility" | "note";
/** src/monitor/types.ts MismatchKind. */
export type MismatchKind = "differs" | "missing_on_surface" | "missing_in_record" | "stale";

export const KIND_TEXT: Record<MismatchKind, string> = {
  differs: "says something different",
  missing_on_surface: "does not have it",
  missing_in_record: "has something your signed record does not",
  stale: "shows an older value",
};

/** One row of the monitor's result, as src/monitor/types.ts Mismatch, with the parent's one action added. */
export interface Mismatch {
  id: string;
  /** The dotted key, shown in plain words by `field`. */
  key: string;
  /** What is compared, in plain words: "Opening hours", "Starter plan price". */
  field: string;
  kind: MismatchKind;
  severity: Severity;
  /** live_page, semanto, merchant_center, business_profile, ucp, acp */
  surface: string;
  /** Where on the surface it was read. */
  surface_url: string | null;
  signed_value: string | null;
  surface_value: string | null;
  /** The fact in the signed record this came from. */
  signed_fact_id: string | null;
  surface_observed_at: string | null;
  /** What differs, in plain words, when the comparison can say. */
  detail?: string;
  /** The one thing to do. Either a link or a handler, not both. */
  action: { label: string; href?: string; onClick?: () => void };
}

export interface ConsistencyMonitorPanelProps {
  mismatches: Mismatch[];
  /** When the monitor last compared every surface. */
  last_run_at: string | null;
  /** How many surfaces were compared in that run. */
  surfaces_checked: number;
}

const ORDER: Severity[] = ["trust", "visibility", "note"];

function Action({ action }: { action: Mismatch["action"] }) {
  const cls = "btn-primary inline-flex items-center gap-1.5 whitespace-nowrap";
  if (action.href) {
    return (
      <a href={action.href} className={cls}>
        {action.label}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={action.onClick}>
      {action.label}
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function ConsistencyMonitorPanel({ mismatches, last_run_at, surfaces_checked }: ConsistencyMonitorPanelProps) {
  const ran = fmtDateTime(last_run_at);
  const groups = ORDER.map((s) => ({ severity: s, items: mismatches.filter((m) => m.severity === s) })).filter((g) => g.items.length > 0);

  return (
    <section aria-labelledby="consistency-title" className="rounded-md border border-hairline">
      <div className="border-b border-hairline px-5 py-4">
        <h2 id="consistency-title" className="text-[15px] font-medium text-text-primary">
          Does everything say the same thing
        </h2>
        <p className="mt-1 text-[13px] text-text-secondary">
          {ran ? `Compared ${surfaces_checked} ${surfaces_checked === 1 ? "surface" : "surfaces"} with your signed record, ${ran}.` : "The monitor has not run yet."}
          {mismatches.length === 0 && ran ? " Everything matches." : null}
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="px-5 py-6 text-[13.5px] text-text-secondary">{ran ? "No mismatches. Nothing to do." : "Results appear here after the first run."}</p>
      ) : (
        groups.map((g) => (
          <div key={g.severity} className="border-b border-hairline last:border-b-0">
            <h3 className="px-5 pt-4 text-[13px] font-medium uppercase tracking-wide text-text-secondary">
              {SEVERITY_TEXT[g.severity]} <span className="font-normal normal-case tracking-normal">({g.items.length})</span>
            </h3>
            <ul className="divide-y divide-hairline">
              {g.items.map((m) => (
                <li key={m.id} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                  <div className="min-w-0">
                    <p className="text-[13.5px] text-text-primary">
                      {m.field}: {SURFACE_TEXT[m.surface] ?? m.surface} {KIND_TEXT[m.kind]}.
                    </p>
                    <dl className="mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                      <dt className="text-text-secondary">You signed</dt>
                      <dd className="break-words text-text-primary">{m.signed_value ?? "Nothing published"}</dd>
                      <dt className="text-text-secondary">It shows</dt>
                      <dd className="break-words text-text-primary">{m.surface_value ?? "Nothing"}</dd>
                    </dl>
                    {m.detail ? <p className="mt-1 text-[13px] text-text-secondary">{m.detail}</p> : null}
                    <p className="mt-1 text-[12.5px] text-text-secondary">
                      {m.surface_observed_at ? `Seen ${fmtDateTime(m.surface_observed_at)}` : "Not seen yet"}
                      {m.surface_url ? (
                        <>
                          {" "}
                          at{" "}
                          <a href={m.surface_url} className="break-all underline underline-offset-2">
                            {m.surface_url}
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Action action={m.action} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
