// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Content negotiation on the Accept header, RFC 9110 section 12.5.1, with the
// same outcomes Cloudflare's Markdown for Agents documents (changelog, 26 Feb
// 2026), so an agent gets the same answer from a Semanto-served page as from a
// Cloudflare-converted one:
//
//   Accept: text/markdown                   -> markdown
//   Accept: text/markdown, text/html;q=0.9  -> markdown
//   Accept: text/*                          -> markdown
//   Accept: */*                             -> html (a browser)
//   Accept: application/ld+json             -> facts (JSON-LD)
//   (no Accept)                             -> html
//
// Every format carries the same content. Nothing here looks at User-Agent:
// serving by user agent is cloaking under Google's spam policies (clarified
// for AI Overviews and AI Mode on 15 May 2026); serving by Accept is not.

export type Representation = "html" | "markdown" | "jsonld" | "json";

export const MEDIA: Record<Representation, string> = {
  html: "text/html",
  markdown: "text/markdown",
  jsonld: "application/ld+json",
  json: "application/json",
};

interface Range {
  type: string;
  subtype: string;
  q: number;
  order: number;
  specificity: number;
}

export function parseAccept(accept: string | null | undefined): Range[] {
  if (!accept || !accept.trim()) return [];
  const out: Range[] = [];
  accept.split(",").forEach((part, order) => {
    const [mt, ...params] = part.trim().split(";");
    if (!mt) return;
    const slash = mt.indexOf("/");
    if (slash < 0) return;
    const type = mt.slice(0, slash).trim().toLowerCase();
    const subtype = mt.slice(slash + 1).trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split("=").map((s) => s.trim());
      if (k?.toLowerCase() === "q" && v !== undefined) {
        const n = Number(v);
        q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
      }
    }
    const specificity = type === "*" ? 0 : subtype === "*" ? 1 : 2;
    out.push({ type, subtype, q, order, specificity });
  });
  return out;
}

function matches(r: Range, media: string): boolean {
  const [t, s] = media.split("/") as [string, string];
  return (r.type === "*" || r.type === t) && (r.subtype === "*" || r.subtype === s);
}

/**
 * Choose among the representations the server offers. `offered` is in server
 * preference order; the client's q wins, specificity breaks ties, then server
 * order. A wildcard-only request (`*\/*` or none) gets `fallback`, which is html.
 */
export function negotiate(accept: string | null | undefined, offered: Representation[], fallback: Representation = "html"): Representation {
  const ranges = parseAccept(accept);
  if (ranges.length === 0) return fallback;
  let best: { rep: Representation; q: number; spec: number; order: number; idx: number } | null = null;
  offered.forEach((rep, idx) => {
    const media = MEDIA[rep];
    let chosen: Range | null = null;
    for (const r of ranges) {
      if (!matches(r, media)) continue;
      if (!chosen || r.specificity > chosen.specificity) chosen = r;
    }
    if (!chosen || chosen.q === 0) return;
    // A bare */* names no preference, so the fallback keeps precedence (browsers).
    if (chosen.specificity === 0 && rep !== fallback) return;
    const cand = { rep, q: chosen.q, spec: chosen.specificity, order: chosen.order, idx };
    if (!best || cand.q > best.q || (cand.q === best.q && (cand.spec > best.spec || (cand.spec === best.spec && cand.idx < best.idx)))) best = cand;
  });
  return best ? (best as { rep: Representation }).rep : fallback;
}

/** A path that asks for a format by suffix, for agents that send no Accept header. */
export function representationFromPath(pathname: string): { rep: Representation | null; basePath: string } {
  if (pathname.endsWith("/index.md")) return { rep: "markdown", basePath: pathname.slice(0, -"index.md".length) };
  if (pathname.endsWith(".md")) return { rep: "markdown", basePath: pathname.slice(0, -3) || "/" };
  if (pathname.endsWith("/facts.jsonld")) return { rep: "jsonld", basePath: pathname.slice(0, -"facts.jsonld".length) };
  if (pathname.endsWith(".jsonld")) return { rep: "jsonld", basePath: pathname.slice(0, -7) || "/" };
  return { rep: null, basePath: pathname };
}
