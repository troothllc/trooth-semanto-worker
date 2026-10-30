// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Netlify: an edge function on every path. It makes
// the shared decision (Accept header and path suffix, never User-Agent),
// fetches the signed bytes from the Trooth API and returns them with the API's
// headers, or calls context.next() so the site answers as before, with the
// Trooth-Semanto-Version and Link headers added to HTML. Edge functions run on
// Deno (docs.netlify.com/edge-functions/overview/); environment variables
// come from Netlify.env. With TROOTH_CONNECTOR_KEY set (the connector private
// JWK), a reader's Web Bot Auth request is forwarded with the host it
// addressed and context.ip, signed, so Trooth can prove the reader.

import type { Config, Context } from "@netlify/edge-functions";
import { handleRequest, createManifestCache, configFromEnv, type ManifestCache } from "../../shared/semanto-adapter.mjs";

declare const Netlify: { env: { get(name: string): string | undefined } };

let manifestCache: ManifestCache | null = null;
// The cache outlives one request; its background refresh is kept alive by whichever request started it.
let current: Context | null = null;

export default async function semanto(request: Request, context: Context): Promise<Response> {
  const config = configFromEnv({
    TROOTH_ID: Netlify.env.get("TROOTH_ID"),
    TROOTH_API_BASE: Netlify.env.get("TROOTH_API_BASE"),
    MODE: Netlify.env.get("MODE") || Netlify.env.get("TROOTH_MODE"),
    TROOTH_CONNECTOR_KEY: Netlify.env.get("TROOTH_CONNECTOR_KEY"),
  });
  if (!config.troothId) return context.next();
  current = context;
  if (!manifestCache) manifestCache = createManifestCache({ config, ttlSeconds: 300, waitUntil: (p) => current?.waitUntil(p) });
  return handleRequest({
    request,
    config: { ...config, clientAddress: context.ip },
    manifestCache,
    next: () => context.next(),
  });
}

export const config: Config = {
  path: "/*",
  excludedPath: ["/_next/*", "/assets/*", "/images/*", "/*.css", "/*.js", "/*.png", "/*.jpg", "/*.svg", "/*.woff2"],
  onError: "bypass",
};
