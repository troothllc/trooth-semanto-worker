// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Vercel, part 2: the route handler the middleware
// rewrites to. It repeats the decision from the original path (the part after
// /semanto) and the Accept header, fetches the bytes from the Trooth API and
// returns them with only the API's headers. Route handlers follow the Next.js
// App Router conventions (nextjs.org/docs/app/api-reference/file-conventions/route).

import { decide, serveWithFallback } from "../../../shared/semanto-adapter.mjs";
import { semantoConfig, semantoManifest, BYPASS_HEADER } from "../../../lib-semanto";

export const dynamic = "force-dynamic";

async function serve(request: Request): Promise<Response> {
  const cfg = semantoConfig();
  // Never a 5xx from the adapter: without TROOTH_ID there is nothing to serve here.
  if (!cfg.troothId) return new Response(null, { status: 404 });
  const url = new URL(request.url);
  const original = url.pathname.replace(/^\/semanto/, "") || "/";
  const manifestCache = semantoManifest();
  const manifest = manifestCache ? await manifestCache.get() : null;
  const decision = decide(original, request.headers.get("accept"), manifest, { ...cfg, method: request.method });
  if (!decision.serve) return new Response(null, { status: 404 });
  // When the API is slow or down and no good copy is stored, the reader gets the site's own page: the middleware lets a
  // request carrying BYPASS_HEADER through untouched, so this cannot loop.
  const next = (req: Request) => fetch(new URL(original + url.search, url.origin), { method: req.method, headers: { Accept: "text/html", [BYPASS_HEADER]: "1" }, cache: "no-store" });
  // With TROOTH_CONNECTOR_KEY, a signed reader's request goes on with the host it addressed and its address, signed.
  return serveWithFallback({ decision, request, config: cfg, fetchInit: { cache: "no-store" }, next });
}

export const GET = serve;
export const HEAD = serve;
