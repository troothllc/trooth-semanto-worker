// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Gcore FastEdge, JavaScript variant (the native
// target is Rust; this file builds to WebAssembly with the FastEdge JS SDK,
// github.com/G-Core/FastEdge-sdk-js). The app runs on the CDN resource's
// "on request" rule: it makes the shared decision (Accept header and path
// suffix, never User-Agent), fetches the signed bytes from the Trooth API and
// returns them with the API's headers, or fetches your origin and adds the
// Trooth-Semanto-Version and Link headers to HTML. Settings come from the
// app's environment variables in the FastEdge panel.

import { getEnv } from "fastedge::env";
import { handleRequest, createManifestCache, configFromEnv } from "../../shared/semanto-adapter.mjs";

let manifestCache = null;

addEventListener("fetch", (event) => event.respondWith(handle(event.request)));

async function handle(request) {
  const config = configFromEnv({
    TROOTH_ID: getEnv("TROOTH_ID"),
    TROOTH_API_BASE: getEnv("TROOTH_API_BASE"),
    MODE: getEnv("MODE"),
  });
  // Your site. The CDN resource's origin hostname, for example origin.example.com.
  const originHost = getEnv("ORIGIN_HOST");
  const next = async (req) => {
    if (!originHost) return fetch(req);
    const u = new URL(req.url);
    u.host = originHost;
    return fetch(new Request(u.toString(), req));
  };
  if (!config.troothId) return next(request);
  if (!manifestCache) manifestCache = createManifestCache({ config, ttlSeconds: 300 });
  return handleRequest({ request, config, manifestCache, next });
}
