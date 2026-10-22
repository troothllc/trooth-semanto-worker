// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Vercel, part 1: Next.js middleware. It makes the
// same decision as every other adapter (Accept header and path suffix, never
// User-Agent) and rewrites a request it will serve to the route handler under
// /semanto. HTML requests pass through with the Trooth-Semanto-Version and
// Link headers added. Vercel reserves /.well-known for rewrites
// (vercel.com/docs/rewrites), so those two files are static files in public/,
// written at build time by scripts/semanto-sync.mjs, and the matcher below
// leaves them alone. Next.js 15 names this file middleware.ts; Next.js 16
// renamed it to proxy.ts with the same export.

import { NextResponse, type NextRequest } from "next/server";
import { decide, proofHeaders, mergeVary } from "./shared/semanto-adapter.mjs";
import { semantoConfig, semantoManifest, SEMANTO_ROUTE } from "./lib-semanto";

export const config = {
  matcher: ["/((?!_next/|semanto/|\\.well-known/|favicon\\.ico|api/).*)"],
};

export async function middleware(request: NextRequest) {
  const cfg = semantoConfig();
  if (!cfg.troothId) return NextResponse.next();
  const manifestCache = semantoManifest();
  const manifest = manifestCache ? await manifestCache.get() : null;
  const { pathname } = request.nextUrl;
  const decision = decide(pathname, request.headers.get("accept"), manifest, { ...cfg, method: request.method });
  if (decision.serve) {
    const url = request.nextUrl.clone();
    url.pathname = SEMANTO_ROUTE + (pathname === "/" ? "/" : pathname);
    return NextResponse.rewrite(url);
  }
  const res = NextResponse.next();
  // The answer at this url depends on Accept (a markdown reader gets another), so every response varies on it, HTML included.
  res.headers.set("Vary", mergeVary(res.headers.get("Vary")));
  if (decision.reason === "html" || decision.reason === "not_listed" || decision.reason === "mode") {
    for (const [k, v] of Object.entries(proofHeaders(manifest, pathname, cfg))) res.headers.set(k, v);
  }
  return res;
}
