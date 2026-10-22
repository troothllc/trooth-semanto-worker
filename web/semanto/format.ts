// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shared formatting for the Semanto dashboard panels: dates in UTC the way
// semanto-record-panel.tsx prints them, counts with tabular digits, and the
// plain-words labels for states and provenance. No fetching, no state.

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${DATE.format(d)} (UTC)`;
}

export function fmtDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${DATE_TIME.format(d)} UTC`;
}

export const fmtCount = (n: number): string => new Intl.NumberFormat("en-US").format(n);

/** Plain words for each surface the monitor compares. */
export const SURFACE_TEXT: Record<string, string> = {
  live_page: "Your live page",
  semanto: "Your signed record",
  merchant_center: "Google Merchant Center",
  business_profile: "Google Business Profile",
  ucp: "Your UCP feed",
  acp: "Your ACP feed",
};

/** src/monitor/types.ts Severity, in the words the company reads. */
export const SEVERITY_TEXT: Record<"trust" | "visibility" | "note", string> = {
  trust: "Google compares this. Fix first",
  visibility: "Cannot be read as data. Fix soon",
  note: "Worth a look",
};
