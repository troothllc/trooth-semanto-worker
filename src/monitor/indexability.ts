// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Per signed page: can Google show it in AI answers? Eligibility is Google's
// rule, stated in its AI features guide (updated 15 June 2026): the page must
// be indexed and snippet-eligible, through the normal index, with no AI
// specific file consulted. This module applies that rule to the signals it
// can see (the PageEntry's index signals from the compile plus a live check):
// a robots noindex or nosnippet (Google "Robots meta tag, data-nosnippet, and
// X-Robots-Tag"), a robots.txt block (RFC 9309), a canonical that points
// elsewhere ("Consolidate duplicate URLs"), a non-200 answer, or a soft 404 by
// title heuristics ("Soft 404 errors" in Search Console help). It also reports
// whether the page carries the JSON-LD block Semanto generated, by its @id.
//
// Eligible here means "nothing we can see rules it out". Indexing is never
// guaranteed by anyone; Google decides what it indexes and shows.

import type { PageEntry } from "../core/semanto";
import { normalizeUrl } from "./normalize";
import type { IndexReason, IndexabilityReport, LivePageRead, PageIndexability } from "./types";

const REASONS: IndexReason[] = ["noindex", "nosnippet", "robots_blocked", "canonical_elsewhere", "non_200", "soft_404", "not_fetched"];

const SOFT_404_TITLE = /\b(404|not found|page not found|page doesn't exist|page does not exist|no longer available|cannot be found|error)\b/i;

export interface IndexabilityOptions {
  /** The @id the compiler's JSON-LD carries for this page. Default: the page url plus "#semanto". */
  generatedId?: (page: PageEntry) => string;
  /** The site's robots.txt text when it was fetched; null when it was not. */
  robotsTxt?: string | null;
  /** The crawler name to match robots.txt groups against. */
  userAgent?: string;
}

export function defaultGeneratedId(page: PageEntry): string {
  return `${page.url.replace(/#.*$/, "")}#semanto`;
}

/** Group-and-rule matching per RFC 9309: longest match wins, allow wins a tie. */
export function robotsAllows(robotsTxt: string, url: string, userAgent = "googlebot"): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && current) current.rules.push({ allow: field === "allow", pattern: value });
  }
  const ua = userAgent.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const r of group.rules) {
    if (!r.pattern) continue;
    if (!patternMatches(r.pattern, path)) continue;
    const length = r.pattern.length;
    if (!best || length > best.length || (length === best.length && r.allow && !best.allow)) best = { allow: r.allow, length };
  }
  return best ? best.allow : true;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp("^" + parts.join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

export function pageIndexability(page: PageEntry, live: LivePageRead | null, opts: IndexabilityOptions = {}): PageIndexability {
  const reasons: IndexReason[] = [];
  const expected = (opts.generatedId ?? defaultGeneratedId)(page);
  const push = (r: IndexReason) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  if (page.index.noindex) push("noindex");
  if (page.index.nosnippet) push("nosnippet");
  if (page.index.robots_blocked) push("robots_blocked");
  if (page.index.canonical && normalizeUrl(page.index.canonical) !== normalizeUrl(page.url)) push("canonical_elsewhere");
  if (opts.robotsTxt && !robotsAllows(opts.robotsTxt, page.url, opts.userAgent)) push("robots_blocked");
  let status: number | null = null;
  let title: string | null = page.title;
  let jsonld_present = false;
  if (!live) push("not_fetched");
  else {
    status = live.status;
    title = live.title ?? page.title;
    if (live.status !== 200) push(live.status === 0 ? "not_fetched" : "non_200");
    if (live.index.noindex) push("noindex");
    if (live.index.nosnippet) push("nosnippet");
    if (live.index.canonical && normalizeUrl(live.index.canonical) !== normalizeUrl(page.url)) push("canonical_elsewhere");
    if (live.status === 200 && live.title && SOFT_404_TITLE.test(live.title)) push("soft_404");
    jsonld_present = live.jsonld_ids.includes(expected);
  }
  return { url: page.url, page_id: page.id, title, status, eligible: reasons.length === 0, reasons, jsonld_present, expected_jsonld_id: expected };
}

export function indexabilityReport(pages: PageEntry[], live: Map<string, LivePageRead | null>, opts: IndexabilityOptions = {}): IndexabilityReport {
  const rows: PageIndexability[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    rows.push(pageIndexability(p, live.get(p.url) ?? null, opts));
  }
  const by_reason = {} as Record<IndexReason, number>;
  for (const r of REASONS) by_reason[r] = 0;
  let eligible = 0;
  let jsonld = 0;
  for (const r of rows) {
    if (r.eligible) eligible += 1;
    if (r.jsonld_present) jsonld += 1;
    for (const reason of r.reasons) by_reason[reason] += 1;
  }
  return { pages: rows, totals: { pages: rows.length, eligible, not_eligible: rows.length - eligible, jsonld_present: jsonld, by_reason } };
}

/** The reason in plain words, for alerts and the dashboard. */
export function reasonInWords(reason: IndexReason): string {
  switch (reason) {
    case "noindex":
      return "tells search engines not to index it";
    case "nosnippet":
      return "tells search engines not to show any of its text";
    case "robots_blocked":
      return "is blocked by your robots.txt file";
    case "canonical_elsewhere":
      return "points search engines to a different address";
    case "non_200":
      return "did not load";
    case "soft_404":
      return "loads but looks like a not found page";
    case "not_fetched":
      return "could not be fetched";
  }
}
