// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shared pieces for the Vercel adapter: the config from environment variables
// and one manifest cache per runtime instance, used by middleware.ts and the
// route handler. Copy this file to the root of your Next.js project next to
// middleware.ts.

import { createManifestCache, configFromEnv, type ManifestCache, type AdapterConfig } from "./shared/semanto-adapter.mjs";

export function semantoConfig(): AdapterConfig {
  return configFromEnv({
    TROOTH_ID: process.env.TROOTH_ID,
    TROOTH_API_BASE: process.env.TROOTH_API_BASE,
    MODE: process.env.MODE || process.env.TROOTH_MODE,
    // The connector private JWK as JSON: signs a forwarded Web Bot Auth request so Trooth can prove the reader.
    TROOTH_CONNECTOR_KEY: process.env.TROOTH_CONNECTOR_KEY,
  });
}

let cache: ManifestCache | null = null;

export function semantoManifest(): ManifestCache | null {
  const config = semantoConfig();
  if (!config.troothId) return null;
  if (!cache) cache = createManifestCache({ config, ttlSeconds: 300 });
  return cache;
}

/** The route the middleware rewrites to. */
export const SEMANTO_ROUTE = "/semanto";
