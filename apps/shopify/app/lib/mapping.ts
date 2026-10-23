// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shopify products to the catalog document the Worker's commerce/catalog route
// reads (catalogToInputs in src/pipeline.ts; the shape is the WooCommerce
// plugin's, adapters/wordpress-plugin/README.md, and connectorCommon's
// catalogDocument in adapters/commerce-platforms/connector-common.mjs). The
// field mapping is the one in adapters/commerce-platforms/shopify/shopify-sync.mjs
// (mapProduct), with one change: the app asks for read_products only, so stock
// comes from availableForSale and no inventory count is sent (the catalog's
// stock field is optional). That script cannot be imported here because it
// reads its settings from the process environment when it loads.
//
// Values are what the store says, so every record the Worker builds from them
// is declared, never witnessed.

import { CONNECTOR_NAME } from "./env";

export interface ShopifyVariantNode {
  id: string;
  legacyResourceId: string | number;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  availableForSale?: boolean | null;
  selectedOptions?: { name: string; value: string }[] | null;
}

export interface ShopifyProductNode {
  id: string;
  legacyResourceId: string | number;
  title: string;
  handle: string;
  status?: string | null;
  updatedAt?: string | null;
  onlineStoreUrl?: string | null;
  description?: string | null;
  variants: ShopifyVariantNode[];
}

export interface ShopInfo {
  name: string;
  url: string;
  currencyCode: string;
}

export type StockStatus = "instock" | "outofstock" | "discontinued";

export interface CatalogVariant {
  id: string;
  sku: string;
  gtin: string | null;
  price: string | null;
  regular_price: string | null;
  stock_status: StockStatus;
  attributes: Record<string, string>;
  url: string;
}

export interface CatalogProduct {
  id: string;
  type: "simple" | "variable";
  name: string;
  url: string;
  description?: string;
  sku: string;
  gtin: string | null;
  price: string | null;
  regular_price: string | null;
  sale_price: null;
  stock_status: StockStatus;
  modified_at: string | null;
  variants: CatalogVariant[];
}

export interface CatalogDocument {
  source: "shopify";
  site: string;
  trooth_id: string;
  currency: string;
  generated_at: string;
  connector: string;
  shop: string;
  products: CatalogProduct[];
}

/** Digits only, the GTIN as the catalog wants it; the Worker checks the check digit itself. */
export const digitsOnly = (s: string | null | undefined): string | null => (s ? String(s).replace(/[^0-9]/g, "") || null : null);

/** The numeric id at the end of a Shopify global id (gid://shopify/Product/123 gives 123). */
export function legacyId(gidOrId: string | number): string {
  const s = String(gidOrId);
  const m = /\/(\d+)$/.exec(s);
  return m ? m[1]! : s;
}

const DESCRIPTION_LIMIT = 5000;

export function mapProduct(p: ShopifyProductNode, storeUrl: string): CatalogProduct {
  const base = storeUrl.replace(/\/+$/, "");
  const productUrl = p.onlineStoreUrl || `${base}/products/${p.handle}`;
  const variants: CatalogVariant[] = p.variants.map((v) => {
    const vid = legacyId(v.legacyResourceId ?? v.id);
    return {
      id: vid,
      sku: v.sku || "",
      gtin: digitsOnly(v.barcode),
      price: v.price ?? null,
      regular_price: v.compareAtPrice ?? v.price ?? null,
      stock_status: v.availableForSale ? "instock" : "outofstock",
      attributes: Object.fromEntries((v.selectedOptions ?? []).filter((o) => o.name !== "Title" || o.value !== "Default Title").map((o) => [o.name, o.value])),
      url: `${base}/products/${p.handle}?variant=${vid}`,
    };
  });
  const first = variants[0];
  const single = variants.length === 1;
  const description = (p.description ?? "").trim().slice(0, DESCRIPTION_LIMIT);
  return {
    id: legacyId(p.legacyResourceId ?? p.id),
    type: variants.length > 1 ? "variable" : "simple",
    name: p.title,
    url: productUrl,
    ...(description ? { description } : {}),
    sku: single ? (first?.sku ?? "") : "",
    gtin: single ? (first?.gtin ?? null) : null,
    price: first?.price ?? null,
    regular_price: first?.regular_price ?? null,
    sale_price: null,
    stock_status: variants.some((v) => v.stock_status === "instock") ? "instock" : "outofstock",
    modified_at: p.updatedAt ?? null,
    variants: variants.length > 1 ? variants : [],
  };
}

/** The same product marked discontinued, sent when the store deletes it or takes it off sale (status draft or archived). */
export function markDiscontinued(p: CatalogProduct): CatalogProduct {
  return { ...p, stock_status: "discontinued", variants: p.variants.map((v) => ({ ...v, stock_status: "discontinued" })) };
}

/** One catalog document; the Worker reads trooth_id, currency, generated_at, source and products. */
export function catalogDocument(shop: string, info: ShopInfo, troothId: string, products: CatalogProduct[], now: Date = new Date()): CatalogDocument {
  return {
    source: "shopify",
    site: info.url,
    trooth_id: troothId,
    currency: info.currencyCode,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    connector: CONNECTOR_NAME,
    shop,
    products,
  };
}

/** A stable hash of what Trooth would receive for a product, without the modified time, so an update that changes nothing sends nothing. */
export async function productHash(p: CatalogProduct): Promise<string> {
  const { modified_at: _m, ...rest } = p;
  const bytes = new TextEncoder().encode(JSON.stringify(rest));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The largest catalog body the app sends in one request; the Worker refuses more than 5 MB (CATALOG_MAX_BYTES). */
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Split products into documents whose JSON stays under maxBytes. A single
 * product larger than the limit (thousands of variants) goes alone; the
 * Worker answers for it and the sync records that answer.
 */
export function chunkProducts(products: CatalogProduct[], envelopeBytes: number, maxBytes: number = CHUNK_MAX_BYTES): CatalogProduct[][] {
  const out: CatalogProduct[][] = [];
  let current: CatalogProduct[] = [];
  let size = envelopeBytes;
  for (const p of products) {
    const n = new TextEncoder().encode(JSON.stringify(p)).length + 1;
    if (current.length && size + n > maxBytes) {
      out.push(current);
      current = [];
      size = envelopeBytes;
    }
    current.push(p);
    size += n;
  }
  if (current.length) out.push(current);
  return out;
}
