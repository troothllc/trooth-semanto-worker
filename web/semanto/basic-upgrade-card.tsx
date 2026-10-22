// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// BasicUpgradeCard: what Semanto Basic (the free tier) has and does not have,
// and one action. The lists are passed in so copy lives with the plan data,
// not here. Follows the plan cards of Linear and Vercel: two short lists,
// one button, no claims about outcomes.

"use client";

import { Check, X } from "lucide-react";

export interface BasicUpgradeCardProps {
  /** What the company has today on Basic. */
  has: string[];
  /** What Basic does not include. */
  lacks: string[];
  action: { label: string; href: string };
  /** Shown under the lists; the price line comes from the parent, never typed here. */
  note?: string;
}

export function BasicUpgradeCard({ has, lacks, action, note }: BasicUpgradeCardProps) {
  return (
    <section aria-labelledby="basic-upgrade-title" className="rounded-md border border-hairline px-5 py-4">
      <h2 id="basic-upgrade-title" className="text-[15px] font-medium text-text-primary">
        You are on Semanto Basic
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-[13px] font-medium text-text-secondary">What you have</h3>
          <ul className="mt-1 space-y-1 text-[13.5px] text-text-primary">
            {has.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Check className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-[13px] font-medium text-text-secondary">What Basic does not include</h3>
          <ul className="mt-1 space-y-1 text-[13.5px] text-text-primary">
            {lacks.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <X className="mt-1 size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {note ? <p className="mt-3 text-[13px] text-text-secondary">{note}</p> : null}
      <a href={action.href} className="btn-primary mt-4 inline-flex">
        {action.label}
      </a>
    </section>
  );
}
