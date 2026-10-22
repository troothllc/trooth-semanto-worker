// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Vercel, part 2: the route handler the middleware
// rewrites to. It repeats the decision from the original path (the part after
// /semanto) and the Accept header, fetches the bytes from the Trooth API and
// returns them with only the API's headers. Route handlers follow the Next.js
// App Router conventions (nextjs.org/docs/app/api-reference/file-conventions/route).

import { decide, fetchSigned } from "../../../shared/semanto-adapter.mjs";
import { semantoConfig, semantoManifest } from "../../../lib-semanto";

export const dynamic = "force-dynamic";

async function serve(request: Request): Promise<Response> {
  const cfg = semantoConfig();
  if (!cfg.troothId) return new Response("TROOTH_ID is not set", { status: 500 });
  const url = new URL(request.url);
  const original = url.pathname.replace(/^\/semanto/, "") || "/";
  const manifestCache = semantoManifest();
  const manifest = manifestCache ? await manifestCache.get() : null;
  const decision = decide(original, request.headers.get("accept"), manifest, { ...cfg, method: request.method });
  if (!decision.serve) return new Response(null, { status: 404 });
  // With TROOTH_CONNECTOR_KEY, a signed reader's request goes on with the host it addressed and its address, signed.
  return fetchSigned(decision, request, fetch, { cache: "no-store" }, cfg);
}

export const GET = serve;
export const HEAD = serve;
