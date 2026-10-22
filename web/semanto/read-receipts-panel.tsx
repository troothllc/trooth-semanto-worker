// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// ReadReceiptsPanel: who read the signed record, by day. An agent is named
// only when its request carried a Web Bot Auth signature that checked out
// against its key directory (draft-ietf-webbotauth-httpsig-protocol); every
// other read is "unproven reader", never a guess from a User-Agent string.
// Trooth's hourly change detection reads the company's own pages, not the
// served record, so it is not in these counts; the panel says so, and the
// "Trooth's checks" column stays for a future Trooth key directory. The CSV
// link is the parent's (GET /os/semanto/{id}/receipts.csv).

"use client";

import { Download } from "lucide-react";
import { fmtCount, fmtDate } from "./format";

export interface ProvenAgent {
  /** The name the key directory publishes for itself, or its host. */
  name: string;
  /** The Signature-Agent directory URL the signature named. */
  directory: string;
  reads: number;
}

export interface ReadReceiptDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  reads: number;
  proven: ProvenAgent[];
  unproven_reads: number;
  /** Reads of the served record made by a Trooth key directory that day, included in `reads`. Zero today: Trooth has no reader key directory yet. */
  trooth_checks: number;
}

export interface ReadReceiptsPanelProps {
  days: ReadReceiptDay[];
  csv_href: string;
  /** Total reads over the shown days, computed by the parent from the same rows. */
  total_reads: number;
}

export function ReadReceiptsPanel({ days, csv_href, total_reads }: ReadReceiptsPanelProps) {
  const trooth = days.reduce((a, d) => a + d.trooth_checks, 0);
  const proven = days.reduce((a, d) => a + d.proven.reduce((b, p) => b + p.reads, 0), 0);
  const agents = new Map<string, ProvenAgent>();
  for (const d of days) for (const p of d.proven) agents.set(p.directory, { ...p, reads: (agents.get(p.directory)?.reads ?? 0) + p.reads });
  const agentList = [...agents.values()].sort((a, b) => b.reads - a.reads);

  return (
    <section aria-labelledby="receipts-title" className="rounded-md border border-hairline">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
        <div>
          <h2 id="receipts-title" className="text-[15px] font-medium text-text-primary">
            Who read your Semanto
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            {days.length === 0 ? "No reads recorded yet." : `${fmtCount(total_reads)} reads over ${days.length} ${days.length === 1 ? "day" : "days"}, of which ${trooth ? `${fmtCount(trooth)} were Trooth's own checks and ` : ""}${fmtCount(proven)} came from readers who proved who they were.`}
          </p>
        </div>
        <a href={csv_href} className="inline-flex items-center gap-1.5 text-[13px] text-text-secondary underline underline-offset-2 hover:text-text-primary" download>
          <Download className="size-3.5" aria-hidden="true" />
          Download CSV
        </a>
      </div>

      {agentList.length > 0 ? (
        <div className="border-b border-hairline px-5 py-4">
          <h3 className="text-[13.5px] font-medium text-text-primary">Readers who proved who they were</h3>
          <ul className="mt-2 space-y-1 text-[13.5px]">
            {agentList.map((a) => (
              <li key={a.directory} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-text-primary">{a.name}</span> <span className="break-all text-[12.5px] text-text-secondary">{a.directory}</span>
                </span>
                <span className="tabular-nums text-text-primary">{fmtCount(a.reads)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-text-secondary">A name appears only when the request was signed and the signature checked out against that reader's published key. A name is the key directory's, not a claim about the company behind it.</p>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-hairline text-left text-[12.5px] text-text-secondary">
              <th scope="col" className="px-5 py-2 font-medium">
                Day (UTC)
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Reads
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Proved who they were
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Unproven reader
              </th>
              <th scope="col" className="px-5 py-2 text-right font-medium">
                Trooth's checks
              </th>
            </tr>
          </thead>
          <tbody>
            {days.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-text-secondary">
                  Reads appear here once your Semanto is served.
                </td>
              </tr>
            ) : (
              days.map((d) => (
                <tr key={d.day} className="border-b border-hairline last:border-b-0">
                  <th scope="row" className="px-5 py-2 text-left font-normal text-text-primary">
                    {fmtDate(`${d.day}T00:00:00Z`)?.replace(" (UTC)", "") ?? d.day}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">{fmtCount(d.reads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">{fmtCount(d.proven.reduce((a, p) => a + p.reads, 0))}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">{fmtCount(d.unproven_reads)}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-text-secondary">{fmtCount(d.trooth_checks)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[12.5px] text-text-secondary">A read is one answer of a signed page, the facts file or the whole file. Trooth's hourly change check reads your own pages, not this record, so it is not counted here.</p>
    </section>
  );
}
