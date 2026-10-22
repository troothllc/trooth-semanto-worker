// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Signed Content Signals. The Content Signals Policy (contentsignals.org,
// Cloudflare, September 2025) lets a site say, in robots.txt and in a
// Content-Signal response header, how its content may be used: search,
// ai-input (answering a question right now) and ai-train (training). Semanto
// carries the policy inside the signed record (controls.content_signals), and
// this module emits the header value and the robots.txt lines from that one
// source, reads what a site currently publishes, and reports drift between
// the two. The policy also signs on its own (JWS typ content-signals) so a
// crawler or a platform can hold the statement without the whole record.

import { JWS_TYPES, signObject, verifyJws } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { Controls } from "../core/semanto";

export type ContentSignalsPolicy = Controls["content_signals"];

export const SIGNAL_NAMES = ["search", "ai-input", "ai-train"] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

export const CONTENT_SIGNAL_HEADER = "Content-Signal";

const yn = (b: boolean) => (b ? "yes" : "no");

/** The header value: "search=yes, ai-input=yes, ai-train=no". */
export function toHeaderValue(p: ContentSignalsPolicy): string {
  return SIGNAL_NAMES.map((n) => `${n}=${yn(p[n])}`).join(", ");
}

/** The robots.txt lines, in the group for every user agent, as contentsignals.org shows them. */
export function toRobotsLines(p: ContentSignalsPolicy): string[] {
  return [
    "# Content Signals policy (contentsignals.org). The same policy is inside the signed Semanto record.",
    "User-Agent: *",
    `Content-Signal: ${toHeaderValue(p)}`,
  ];
}

/** Parse "search=yes, ai-input=no" into a policy. Unknown names are ignored; a missing name is absent (undefined). */
export function parseSignalValue(value: string): Partial<ContentSignalsPolicy> {
  const out: Partial<ContentSignalsPolicy> = {};
  for (const part of value.split(",")) {
    const m = /^\s*([a-z-]+)\s*=\s*(yes|no)\s*$/i.exec(part);
    if (!m) continue;
    const name = m[1]!.toLowerCase() as SignalName;
    if (!(SIGNAL_NAMES as readonly string[]).includes(name)) continue;
    out[name] = m[2]!.toLowerCase() === "yes";
  }
  return out;
}

/** The first Content-Signal line in robots.txt, or null when there is none. */
export function parseRobotsSignals(robots: string): Partial<ContentSignalsPolicy> | null {
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*content-signal\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) return parseSignalValue(m[1]!);
  }
  return null;
}

export function parseHeaderSignals(headers: Record<string, string>): Partial<ContentSignalsPolicy> | null {
  const k = Object.keys(headers).find((h) => h.toLowerCase() === "content-signal");
  return k ? parseSignalValue(headers[k]!) : null;
}

export interface SurfaceDrift {
  present: boolean;
  found: Partial<ContentSignalsPolicy> | null;
  /** Signals whose published value differs from the signed policy, or that are missing. */
  differs: { signal: SignalName; signed: boolean; published: boolean | null }[];
  matches: boolean;
}

export interface ContentSignalsDrift {
  signed: ContentSignalsPolicy;
  robots: SurfaceDrift;
  header: SurfaceDrift;
  /** True only when both surfaces carry the signed policy in full. */
  matches: boolean;
  words: string;
}

function driftOf(signed: ContentSignalsPolicy, found: Partial<ContentSignalsPolicy> | null): SurfaceDrift {
  if (!found) return { present: false, found: null, differs: SIGNAL_NAMES.map((s) => ({ signal: s, signed: signed[s], published: null })), matches: false };
  const differs = SIGNAL_NAMES.filter((s) => found[s] !== signed[s]).map((s) => ({ signal: s, signed: signed[s], published: found[s] ?? null }));
  return { present: true, found, differs, matches: differs.length === 0 };
}

/** Compare what the site publishes now with the signed policy. */
export function checkContentSignalsDrift(signed: ContentSignalsPolicy, site: { robotsTxt: string | null; headers: Record<string, string> }): ContentSignalsDrift {
  const robots = driftOf(signed, site.robotsTxt === null ? null : parseRobotsSignals(site.robotsTxt));
  const header = driftOf(signed, parseHeaderSignals(site.headers));
  const matches = robots.matches && header.matches;
  const parts: string[] = [];
  if (matches) parts.push("robots.txt and the Content-Signal header both carry the signed policy.");
  else {
    if (!robots.present) parts.push("robots.txt has no Content-Signal line.");
    else if (!robots.matches) parts.push(`robots.txt differs on ${robots.differs.map((d) => d.signal).join(", ")}.`);
    if (!header.present) parts.push("The site sends no Content-Signal header.");
    else if (!header.matches) parts.push(`The Content-Signal header differs on ${header.differs.map((d) => d.signal).join(", ")}.`);
    parts.push(`The signed policy is: ${toHeaderValue(signed)}.`);
  }
  return { signed, robots, header, matches, words: parts.join(" ") };
}

// ------------------------------------------------------------------ the signed policy on its own

export interface SignedContentSignals {
  object: "semanto.content_signals";
  trooth_id: string;
  domain: string;
  policy: ContentSignalsPolicy;
  /** ISO 8601, when the policy was stated. */
  as_of: string;
  header: string;
  robots_lines: string[];
}

export async function signContentSignals(input: { trooth_id: string; domain: string; policy: ContentSignalsPolicy; as_of: Date; exp?: Date }, key: PrivateJwk): Promise<{ statement: SignedContentSignals; jws: string }> {
  const statement: SignedContentSignals = {
    object: "semanto.content_signals",
    trooth_id: input.trooth_id,
    domain: input.domain.toLowerCase(),
    policy: { search: input.policy.search, "ai-input": input.policy["ai-input"], "ai-train": input.policy["ai-train"] },
    as_of: input.as_of.toISOString(),
    header: toHeaderValue(input.policy),
    robots_lines: toRobotsLines(input.policy),
  };
  const signed = await signObject(statement, key, JWS_TYPES.contentSignals, { iat: input.as_of, nbf: input.as_of, ...(input.exp ? { exp: input.exp } : {}) });
  return { statement, jws: signed.compact };
}

export async function verifyContentSignals(jws: string, resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null, at?: Date): Promise<{ ok: true; statement: SignedContentSignals } | { ok: false; reason: string }> {
  const v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.contentSignals, ...(at ? { at } : {}) });
  if (!v.ok) return { ok: false, reason: v.reason };
  const s = v.payload as SignedContentSignals;
  if (s.object !== "semanto.content_signals" || !s.policy) return { ok: false, reason: "malformed" };
  if (s.header !== toHeaderValue(s.policy)) return { ok: false, reason: "header_does_not_match_policy" };
  return { ok: true, statement: s };
}
