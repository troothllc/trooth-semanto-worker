// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shopify connector: reads products and variants through the Admin GraphQL
// API (2025-10, shopify.dev/docs/api/admin-graphql) with cursor pagination and
// POSTs them to the Trooth API as one signed catalog document. Run it from a
// custom app's server, a scheduled job, or by hand. Node 20 or newer, no
// dependencies. Shopify allows no custom root paths, so the store's signed
// copy is served by Trooth; this script keeps the product records current.
//
//   SHOPIFY_SHOP=acme.myshopify.com SHOPIFY_ADMIN_TOKEN=<admin token> \
//   TROOTH_ID=acme-inc node shopify-sync.mjs [--dry-run]

import { env, catalogDocument, send, digitsOnly } from "../connector-common.mjs";

const shop = env("SHOPIFY_SHOP");
const token = env("SHOPIFY_ADMIN_TOKEN");
const troothId = env("TROOTH_ID");
const apiBase = env("TROOTH_API_BASE", "https://api.trooth.co");
const apiVersion = env("SHOPIFY_API_VERSION", "2025-10");
const dryRun = process.argv.includes("--dry-run");

/** Products with their variants: sku, barcode (GTIN), price, stock. Scope needed: read_products, read_inventory. */
export const PRODUCTS_QUERY = `
query TroothCatalog($cursor: String) {
  shop { name primaryDomain { url } currencyCode }
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId title handle status updatedAt onlineStoreUrl
      variants(first: 100) {
        nodes {
          id legacyResourceId title sku barcode price compareAtPrice
          availableForSale inventoryQuantity
          selectedOptions { name value }
        }
      }
    }
  }
}`;

async function graphql(query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify answered ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function stockStatus(v) {
  if (!v.availableForSale) return "outofstock";
  if (typeof v.inventoryQuantity === "number" && v.inventoryQuantity <= 0) return "onbackorder";
  return "instock";
}

export function mapProduct(p, storeUrl) {
  const variants = p.variants.nodes.map((v) => ({
    id: String(v.legacyResourceId),
    sku: v.sku || "",
    gtin: digitsOnly(v.barcode),
    price: v.price ?? null,
    regular_price: v.compareAtPrice ?? v.price ?? null,
    stock_status: stockStatus(v),
    stock: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
    attributes: Object.fromEntries((v.selectedOptions || []).map((o) => [o.name, o.value])),
    url: `${storeUrl}/products/${p.handle}?variant=${v.legacyResourceId}`,
  }));
  const first = variants[0] || {};
  return {
    id: String(p.legacyResourceId),
    type: variants.length > 1 ? "variable" : "simple",
    name: p.title,
    url: p.onlineStoreUrl || `${storeUrl}/products/${p.handle}`,
    sku: variants.length === 1 ? first.sku || "" : "",
    gtin: variants.length === 1 ? first.gtin || null : null,
    price: first.price ?? null,
    regular_price: first.regular_price ?? null,
    sale_price: null,
    stock_status: variants.some((v) => v.stock_status === "instock") ? "instock" : "outofstock",
    stock: variants.reduce((n, v) => (typeof v.stock === "number" ? n + v.stock : n), 0),
    modified_at: p.updatedAt,
    variants: variants.length > 1 ? variants : [],
  };
}

async function main() {
  const products = [];
  let cursor = null;
  let shopInfo = null;
  do {
    const data = await graphql(PRODUCTS_QUERY, { cursor });
    shopInfo = shopInfo || data.shop;
    const storeUrl = shopInfo.primaryDomain.url.replace(/\/+$/, "");
    for (const p of data.products.nodes) products.push(mapProduct(p, storeUrl));
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  const doc = catalogDocument({ source: "shopify", site: shopInfo.primaryDomain.url, troothId, currency: shopInfo.currencyCode, products, extra: { shop: shopInfo.name } });
  await send(doc, { apiBase, troothId, dryRun });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
