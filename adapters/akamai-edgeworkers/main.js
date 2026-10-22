// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto host adapter for Akamai EdgeWorkers. onClientRequest makes the
// shared decision (Accept header and path suffix, never User-Agent). A request
// the adapter serves is routed to the `trooth_api` conditional origin with
// request.route(), so the API's body streams back at any size with its own
// headers; the manifest is read with httpRequest() and kept in memory with its
// ETag. onClientResponse adds the Trooth-Semanto-Version and Link headers to
// the site's HTML and Vary: Accept to every response it touches. With a
// connector private JWK in PMUSER_TROOTH_CONNECTOR_KEY and WebCrypto Ed25519
// available, a reader's Web Bot Auth request is routed with the host it
// addressed and its True-Client-IP, signed (Trooth-Connector-Signature), so
// Trooth can prove the reader; without them the reader is unproven. Follows
// the EdgeWorkers request object API
// (techdocs.akamai.com/edgeworkers/docs/request-object) and the http-request
// module (techdocs.akamai.com/edgeworkers/docs/http-request).

import { httpRequest } from "http-request";
import { logger } from "log";
import { decide, proofHeaders, apiRoot, configFromEnv, API_PATHS, mergeVary, forwardingHeaders } from "./semanto-adapter.mjs";

// The three settings. Set them here or as property variables PMUSER_TROOTH_ID,
// PMUSER_TROOTH_MODE and PMUSER_TROOTH_API_BASE (variables win).
const DEFAULTS = {
  TROOTH_ID: "example-inc",
  TROOTH_API_BASE: "https://api.trooth.co",
  MODE: "semanto_only",
};

// The conditional origin in the property that points at api.trooth.co.
const API_ORIGIN = "trooth_api";
const MANIFEST_TTL_MS = 300000;

let manifestState = { manifest: null, etag: null, fetchedAt: 0 };

function settings(request) {
  return configFromEnv({
    TROOTH_ID: request.getVariable("PMUSER_TROOTH_ID") || DEFAULTS.TROOTH_ID,
    TROOTH_API_BASE: request.getVariable("PMUSER_TROOTH_API_BASE") || DEFAULTS.TROOTH_API_BASE,
    MODE: request.getVariable("PMUSER_TROOTH_MODE") || DEFAULTS.MODE,
    TROOTH_CONNECTOR_KEY: request.getVariable("PMUSER_TROOTH_CONNECTOR_KEY") || undefined,
  });
}

async function manifest(config) {
  const now = Date.now();
  if (manifestState.manifest && now - manifestState.fetchedAt < MANIFEST_TTL_MS) return manifestState.manifest;
  const headers = { Accept: "application/json" };
  if (manifestState.etag) headers["If-None-Match"] = manifestState.etag;
  try {
    const res = await httpRequest(apiRoot(config) + API_PATHS.manifest, { headers });
    if (res.status === 304 && manifestState.manifest) {
      manifestState.fetchedAt = now;
      return manifestState.manifest;
    }
    if (res.ok) {
      const body = await res.json();
      manifestState = { manifest: body, etag: res.getHeader("ETag") ? res.getHeader("ETag")[0] : null, fetchedAt: now };
      return body;
    }
  } catch (e) {
    logger.log("semanto manifest fetch failed: %s", String(e));
  }
  return manifestState.manifest;
}

export async function onClientRequest(request) {
  const config = settings(request);
  if (!config.troothId) return;
  const m = await manifest(config);
  const accept = request.getHeader("Accept");
  const decision = decide(request.path, accept ? accept[0] : null, m, { ...config, method: request.method });
  if (!decision.serve) {
    request.setVariable("PMUSER_SEMANTO_SERVED", "0");
    return;
  }
  request.setVariable("PMUSER_SEMANTO_SERVED", "1");
  await addForwarding(request, decision, config);
  // Route to the Trooth API: path and query of the decided url, same Accept header.
  const target = decision.url.replace(/^https?:\/\/[^/]+/, "");
  const q = target.indexOf("?");
  request.route({ origin: API_ORIGIN, path: q >= 0 ? target.slice(0, q) : target, query: q >= 0 ? target.slice(q + 1) : "" });
}

/** A signed reader's request: add the forwarding headers and the connector signature. Any failure leaves the reader unproven. */
async function addForwarding(request, decision, config) {
  const h = (name) => {
    const v = request.getHeader(name);
    return v ? v[0] : null;
  };
  if (!h("Signature-Input") || !h("Signature") || !h("Signature-Agent")) return;
  try {
    const headers = new Headers();
    for (const name of ["Accept", "Accept-Language", "If-None-Match", "Signature-Input", "Signature", "Signature-Agent", "True-Client-IP"]) if (h(name)) headers.set(name, h(name));
    const shaped = { url: `https://${request.host}${request.url}`, method: "GET", headers };
    const out = await forwardingHeaders(decision, shaped, { ...config, clientAddress: h("True-Client-IP") || "" });
    for (const name of ["Trooth-Forwarded-Authority", "Trooth-Forwarded-For", "Trooth-Connector-Signature-Input", "Trooth-Connector-Signature"]) {
      const v = out.get(name);
      if (v) request.setHeader(name, v);
    }
  } catch (e) {
    logger.log("semanto forwarding not signed: %s", String(e));
  }
}

export async function onClientResponse(request, response) {
  // Every response here varies on Accept, the site's HTML included.
  const vary = response.getHeader("Vary");
  response.setHeader("Vary", mergeVary(vary ? vary.join(", ") : ""));
  if (request.getVariable("PMUSER_SEMANTO_SERVED") === "1") return;
  const ct = response.getHeader("Content-Type");
  if (!ct || !/^text\/html/i.test(ct[0])) return;
  const config = settings(request);
  if (!config.troothId) return;
  const add = proofHeaders(manifestState.manifest, request.path, config);
  for (const name of Object.keys(add)) {
    if (name === "Link" && response.getHeader("Link")) response.addHeader("Link", add[name]);
    else response.setHeader(name, add[name]);
  }
}
