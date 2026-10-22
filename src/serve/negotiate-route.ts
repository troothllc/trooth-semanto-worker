// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Decide the representation of a company page from the path and the Accept
// header, through src/core/negotiate.ts, with the outcomes Cloudflare's
// Markdown for Agents documents (changelog, 26 Feb 2026) so an agent gets the
// same answer from both. User-Agent is never read (Google spam policies on
// cloaking, clarified 15 May 2026).
//
//   Accept: text/markdown or text/*      -> markdown
//   Accept: application/ld+json          -> jsonld (the page's JSON-LD)
//   Accept: */* or none                  -> html (passthrough: the host serves HTML)
//   path .md, /index.md                  -> markdown, whatever Accept says
//   path .jsonld, /facts.jsonld          -> jsonld, whatever Accept says

import { negotiate, representationFromPath, type Representation } from "../core/negotiate";

export type PageRepresentation = "html" | "markdown" | "jsonld";

export interface RouteDecision {
  rep: PageRepresentation;
  /** The path with any format suffix removed, so the page can be found by its canonical url. */
  basePath: string;
  /** True when the path suffix chose the format. */
  forcedByPath: boolean;
}

/** Server preference order. markdown before html so that text/* resolves to markdown, as Cloudflare documents. */
const OFFERED: Representation[] = ["markdown", "jsonld", "html"];

export function negotiateRoute(pathname: string, accept: string | null | undefined): RouteDecision {
  const byPath = representationFromPath(pathname);
  if (byPath.rep === "markdown" || byPath.rep === "jsonld") return { rep: byPath.rep, basePath: byPath.basePath, forcedByPath: true };
  const rep = negotiate(accept, OFFERED, "html");
  return { rep: rep === "json" ? "html" : rep, basePath: pathname, forcedByPath: false };
}
