// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Salesforce Commerce (B2C) connector: reads products and variants through
// the OCAPI Shop API (developer.salesforce.com/docs/commerce/b2c-commerce/
// references/ocapi, product_search then products/{id} with expand=variations,
// prices,availability) and POSTs them to the Trooth API as one signed catalog
// document. Node 20 or newer, no dependencies. The Shop API needs a client id
// with the Shop API allowed in Business Manager (Administration, Site
// Development, Open Commerce API Settings).
//
//   SFCC_HOST=zzrf-001.dx.commercecloud.salesforce.com SFCC_SITE_ID=RefArch \
//   SFCC_CLIENT_ID=<client id> TROOTH_ID=acme-inc node sfcc-sync.mjs [--dry-run]

import { env, catalogDocument, send, digitsOnly } from "../connector-common.mjs";

const host = env("SFCC_HOST");
const siteId = env("SFCC_SITE_ID");
const clientId = env("SFCC_CLIENT_ID");
const ocapiVersion = env("SFCC_OCAPI_VERSION", "v24_5");
const storefront = env("SFCC_STOREFRONT_URL", `https://${host}`);
const troothId = env("TROOTH_ID");
const apiBase = env("TROOTH_API_BASE", "https://api.trooth.co");
const dryRun = process.argv.includes("--dry-run");

const base = `https://${host}/s/${encodeURIComponent(siteId)}/dw/shop/${ocapiVersion}`;

async function ocapi(path) {
  const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(clientId)}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OCAPI answered ${res.status} for ${path}`);
  return res.json();
}

const stock = (inv) => (inv ? (inv.orderable ? "instock" : inv.backorderable || inv.preorderable ? "onbackorder" : "outofstock") : "outofstock");

export function mapProduct(p, variantDetails) {
  const variants = (p.variants || []).map((v) => {
    const d = variantDetails[v.product_id] || {};
    return {
      id: v.product_id,
      sku: v.product_id,
      gtin: digitsOnly(d.upc || d.ean),
      price: v.price != null ? String(v.price) : d.price != null ? String(d.price) : null,
      stock_status: stock(d.inventory),
      stock: d.inventory && typeof d.inventory.stock_level === "number" ? d.inventory.stock_level : null,
      attributes: v.variation_values || {},
      url: `${storefront}/${encodeURIComponent(v.product_id)}.html`,
    };
  });
  return {
    id: p.id,
    type: variants.length > 1 ? "variable" : "simple",
    name: p.name,
    url: `${storefront}/${encodeURIComponent(p.id)}.html`,
    sku: p.id,
    gtin: digitsOnly(p.upc || p.ean),
    price: p.price != null ? String(p.price) : null,
    regular_price: p.price_max != null ? String(p.price_max) : p.price != null ? String(p.price) : null,
    sale_price: null,
    stock_status: stock(p.inventory),
    stock: p.inventory && typeof p.inventory.stock_level === "number" ? p.inventory.stock_level : null,
    modified_at: null,
    variants: variants.length > 1 ? variants : [],
  };
}

async function main() {
  const products = [];
  let start = 0;
  const count = 200;
  for (;;) {
    const search = await ocapi(`/product_search?q=&start=${start}&count=${count}`);
    for (const hit of search.hits || []) {
      const p = await ocapi(`/products/${encodeURIComponent(hit.product_id)}?expand=prices,availability,variations`);
      const details = {};
      for (const v of p.variants || []) {
        const d = await ocapi(`/products/${encodeURIComponent(v.product_id)}?expand=prices,availability`);
        details[v.product_id] = d;
      }
      products.push(mapProduct(p, details));
    }
    start += count;
    if (!search.total || start >= search.total) break;
  }
  const doc = catalogDocument({ source: "salesforce-commerce", site: storefront + "/", troothId, currency: env("SFCC_CURRENCY", "USD"), products });
  await send(doc, { apiBase, troothId, dryRun });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
