// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for a Cloudflare zone: a Worker on a route over the
// customer's domain. It answers requests for signed markdown, JSON-LD and the
// well-known files from the Trooth-hosted copy, byte for byte with the API's
// headers, and passes everything else to the origin with fetch(request). The
// manifest is kept in the Cache API with its ETag. With TROOTH_CONNECTOR_KEY
// set (a Worker secret: the connector private JWK registered in the
// dashboard), a reader's Web Bot Auth request is forwarded with the host it
// addressed and its CF-Connecting-IP, signed, so Trooth can prove the reader. Follows the Workers routes
// model (developers.cloudflare.com/workers/configuration/routing/routes/) and
// the Cache API (developers.cloudflare.com/workers/runtime-apis/cache/).
// Nothing here reads User-Agent.

import { handleRequest, createManifestCache, configFromEnv, type ManifestStore } from "./semanto-adapter.mjs";

export interface Env {
  TROOTH_ID: string;
  TROOTH_API_BASE?: string;
  MODE?: string;
  /** Secret: the connector private JWK as JSON (wrangler secret put TROOTH_CONNECTOR_KEY). */
  TROOTH_CONNECTOR_KEY?: string;
}

/** A manifest store on the Cache API: one synthetic URL per Trooth ID, the entry's ETag and time inside the body. */
function cacheApiStore(): ManifestStore {
  const cache = (caches as unknown as { default: Cache }).default;
  const keyUrl = (key: string) => new Request(`https://semanto-adapter.invalid/manifest/${encodeURIComponent(key)}`);
  return {
    async get(key) {
      const hit = await cache.match(keyUrl(key));
      if (!hit) return null;
      try {
        return (await hit.json()) as { etag: string | null; manifest: unknown; fetchedAt: number };
      } catch {
        return null;
      }
    },
    async put(key, value) {
      await cache.put(keyUrl(key), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } }));
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const config = configFromEnv(env as unknown as Record<string, string | undefined>);
    if (!config.troothId) return fetch(request);
    // A stored manifest answers at once; a fresh one is fetched after the response is sent.
    const manifestCache = createManifestCache({ config, store: cacheApiStore(), ttlSeconds: 300, waitUntil: ctx ? (p) => ctx.waitUntil(p) : null });
    return handleRequest({
      request,
      // CF-Connecting-IP is set by Cloudflare itself on every proxied request; a client cannot set it.
      config: { ...config, clientAddress: request.headers.get("CF-Connecting-IP") ?? "" },
      manifestCache,
      next: (req) => fetch(req),
    });
  },
};
