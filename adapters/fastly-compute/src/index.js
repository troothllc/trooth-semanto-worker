// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Fastly Compute (JavaScript). The shared decision
// runs on every request; a request the adapter serves is fetched from the
// `trooth_api` backend and returned with the API's headers, everything else
// goes to the `origin` backend untouched, with the Trooth-Semanto-Version and
// Link headers added to HTML. Uses the fetch-backend pattern from the Compute
// JavaScript SDK (js-compute-reference-docs.edgecompute.app) and an optional
// Config Store named `trooth_semanto` for the three settings.
// Nothing here reads User-Agent.

/// <reference types="@fastly/js-compute" />
import { ConfigStore } from "fastly:config-store";
import { handleRequest, createManifestCache, configFromEnv } from "../../shared/semanto-adapter.mjs";

// Defaults, used when there is no Config Store. Edit these or create the store.
const DEFAULTS = {
  TROOTH_ID: "example-inc",
  TROOTH_API_BASE: "https://api.trooth.co",
  MODE: "semanto_only",
};

function settings() {
  const out = { ...DEFAULTS };
  try {
    const store = new ConfigStore("trooth_semanto");
    for (const k of Object.keys(DEFAULTS)) {
      const v = store.get(k);
      if (v) out[k] = v;
    }
  } catch {
    // No Config Store on this service: the defaults above apply.
  }
  return out;
}

const apiFetch = (url, init = {}) => fetch(url, { ...init, backend: "trooth_api" });

let manifestCache = null;

addEventListener("fetch", (event) => event.respondWith(handle(event.request)));

async function handle(request) {
  const config = configFromEnv(settings());
  if (!manifestCache) manifestCache = createManifestCache({ config, fetchImpl: apiFetch, ttlSeconds: 300 });
  return handleRequest({
    request,
    config,
    manifestCache,
    fetchImpl: apiFetch,
    next: (req) => fetch(req, { backend: "origin" }),
  });
}
