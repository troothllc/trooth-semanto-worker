// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// BigCommerce connector: reads products with their variants through the
// Catalog API v3 (developer.bigcommerce.com/docs/rest-catalog/products,
// GET /v3/catalog/products?include=variants) and POSTs them to the Trooth API
// as one signed catalog document. Node 20 or newer, no dependencies.
//
//   BC_STORE_HASH=abc123 BC_ACCESS_TOKEN=<token> TROOTH_ID=acme-inc node bigcommerce-sync.mjs [--dry-run]
// Scopes: Products read-only, Store Information read-only.

import { env, catalogDocument, send, digitsOnly } from "../connector-common.mjs";

const storeHash = env("BC_STORE_HASH");
const token = env("BC_ACCESS_TOKEN");
const troothId = env("TROOTH_ID");
const apiBase = env("TROOTH_API_BASE", "https://api.trooth.co");
const dryRun = process.argv.includes("--dry-run");

async function bc(path) {
  const res = await fetch(`https://api.bigcommerce.com/stores/${storeHash}${path}`, { headers: { "X-Auth-Token": token, Accept: "application/json" } });
  if (!res.ok) throw new Error(`BigCommerce answered ${res.status} for ${path}`);
  return res.json();
}

const availability = (p) => (p.availability === "available" ? "instock" : p.availability === "preorder" ? "onbackorder" : "outofstock");

export function mapProduct(p, siteUrl) {
  const variants = (p.variants || []).map((v) => ({
    id: String(v.id),
    sku: v.sku || "",
    gtin: digitsOnly(v.gtin || v.upc || v.ean),
    price: v.calculated_price != null ? String(v.calculated_price) : v.price != null ? String(v.price) : String(p.price),
    stock_status: v.purchasing_disabled ? "outofstock" : p.inventory_tracking === "none" ? availability(p) : v.inventory_level > 0 ? "instock" : "outofstock",
    stock: p.inventory_tracking === "none" ? null : v.inventory_level,
    attributes: Object.fromEntries((v.option_values || []).map((o) => [o.option_display_name, o.label])),
    url: `${siteUrl}${p.custom_url?.url || "/"}`,
  }));
  return {
    id: String(p.id),
    type: variants.length > 1 ? "variable" : "simple",
    name: p.name,
    url: `${siteUrl}${p.custom_url?.url || "/"}`,
    sku: p.sku || "",
    gtin: digitsOnly(p.gtin || p.upc),
    price: String(p.price),
    regular_price: p.retail_price ? String(p.retail_price) : String(p.price),
    sale_price: p.sale_price ? String(p.sale_price) : null,
    stock_status: p.inventory_tracking === "none" ? availability(p) : p.inventory_level > 0 ? "instock" : "outofstock",
    stock: p.inventory_tracking === "none" ? null : p.inventory_level,
    modified_at: p.date_modified,
    variants: variants.length > 1 ? variants : [],
  };
}

async function main() {
  const store = (await bc("/v2/store")) || {};
  const siteUrl = (store.secure_url || store.domain || "").replace(/\/+$/, "");
  const products = [];
  let page = 1;
  for (;;) {
    const data = await bc(`/v3/catalog/products?include=variants&is_visible=true&limit=250&page=${page}`);
    for (const p of data.data) products.push(mapProduct(p, siteUrl));
    if (!data.meta?.pagination || page >= data.meta.pagination.total_pages) break;
    page++;
  }
  const doc = catalogDocument({ source: "bigcommerce", site: siteUrl + "/", troothId, currency: store.currency || "USD", products });
  await send(doc, { apiBase, troothId, dryRun });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
