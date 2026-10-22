// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shared by the three commerce scripts: the connector key file (made once,
// public half printed for the Trooth dashboard), the catalog document shape
// every platform maps into, and the signed POST to the API. The document shape
// is the one the WooCommerce plugin sends, so the API has one input.

import { readFile, writeFile } from "node:fs/promises";
import { generateConnectorKey, postSigned } from "../shared/sign-request.mjs";

export const KEY_FILE = process.env.TROOTH_CONNECTOR_KEY_FILE || "./trooth-connector-key.json";

export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
}

export async function loadOrCreateKey() {
  try {
    return JSON.parse(await readFile(KEY_FILE, "utf8"));
  } catch {
    const { publicJwk, privateJwk } = await generateConnectorKey();
    await writeFile(KEY_FILE, JSON.stringify(privateJwk, null, 2) + "\n", { mode: 0o600 });
    console.error(`Made a new connector key at ${KEY_FILE}. Paste this public key into the Trooth dashboard under Delivery, Connectors:`);
    console.error(JSON.stringify(publicJwk));
    return privateJwk;
  }
}

export function endpoint(apiBase, troothId) {
  return `${apiBase.replace(/\/+$/, "")}/os/semanto/${encodeURIComponent(troothId)}/commerce/catalog`;
}

/** The document the API receives, same shape for every platform. */
export function catalogDocument({ source, site, troothId, currency, products, extra = {} }) {
  return {
    source,
    site,
    trooth_id: troothId,
    currency,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    connector: `trooth-semanto-${source}/0.1.0`,
    products,
    ...extra,
  };
}

export async function send(document, { apiBase, troothId, dryRun }) {
  const url = endpoint(apiBase, troothId);
  if (dryRun) {
    console.log(JSON.stringify(document, null, 2));
    console.error(`dry run: would POST ${document.products.length} products to ${url}`);
    return;
  }
  const privateJwk = await loadOrCreateKey();
  const res = await postSigned({ url, document, privateJwk });
  const text = await res.text();
  if (res.ok) console.error(`Sent ${document.products.length} products to Trooth (answer ${res.status}). ${text}`);
  else {
    console.error(`Trooth answered ${res.status}: ${text}`);
    process.exit(1);
  }
}

export const digitsOnly = (s) => (s ? String(s).replace(/[^0-9]/g, "") || null : null);
