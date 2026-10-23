// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Admin GraphQL calls the app makes (GraphQL only: App Store requirement
// 2.2.4), each with the scope it needs:
//
//   shop { name primaryDomain currencyCode myshopifyDomain }      no scope
//   bulkOperationRunQuery, node(id) on BulkOperation              read_products (for the products it reads)
//   product(id) with variants, paged                              read_products
//   currentAppInstallation { id }, metafieldsSet, metafieldsDelete
//     on the app's own installation (namespace trooth)            no scope (app-owned data)
//
// The theme app embed reads the Trooth ID from those installation metafields
// (app.metafields.trooth.trooth_id in Liquid), so the app never edits theme
// files and needs no themes scope. A throttled answer (HTTP 429 or the
// THROTTLED error code) or a 5xx is retried with backoff.

import type { ShopifyProductNode, ShopifyVariantNode, ShopInfo } from "./mapping";
import { METAFIELD_NAMESPACE } from "./env";
import { RetryExhausted } from "./retry";

/** Run a GraphQL document and return its data, or throw ShopifyGraphqlError. */
export type Gql = <T = Record<string, unknown>>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface AdminLike {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function throttled(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((e) => (e as { extensions?: { code?: string } })?.extensions?.code === "THROTTLED");
}

/** A Gql over the library's admin client (authenticate.admin or unauthenticated.admin), with retries. */
export function gqlFromAdmin(admin: AdminLike, opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Gql {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? sleepDefault;
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    let last: ShopifyGraphqlError | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await admin.graphql(query, variables ? { variables } : undefined);
        if (res.status === 429 || res.status >= 500) throw new ShopifyGraphqlError(`Shopify answered ${res.status}.`, true);
        const json = (await res.json()) as { data?: T; errors?: unknown };
        if (json.errors) throw new ShopifyGraphqlError(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`, throttled(json.errors));
        if (!json.data) throw new ShopifyGraphqlError("Shopify answered without data.", false);
        return json.data;
      } catch (e) {
        const err = e instanceof ShopifyGraphqlError ? e : classify(e);
        if (!err.retryable) throw err;
        last = err;
        if (i < attempts - 1) await sleep(Math.floor(Math.random() * Math.min(30000, 1000 * 2 ** i)) + 250);
      }
    }
    throw new RetryExhausted(last?.message ?? "Shopify did not answer.", null);
  };
}

/** The library throws its own errors for HTTP failures and GraphQL errors; read the status or code from them. */
function classify(e: unknown): ShopifyGraphqlError {
  const any = e as { response?: { status?: number; code?: number }; body?: { errors?: unknown }; message?: string };
  const status = any?.response?.status ?? any?.response?.code;
  if (typeof status === "number" && (status === 429 || status >= 500)) return new ShopifyGraphqlError(`Shopify answered ${status}.`, true);
  if (throttled(any?.body?.errors) || /THROTTLED|Throttled/.test(any?.message ?? "")) return new ShopifyGraphqlError("Shopify asked the app to slow down.", true);
  if (e instanceof TypeError) return new ShopifyGraphqlError(`Shopify could not be reached (${e.message}).`, true);
  return new ShopifyGraphqlError(any?.message ?? String(e), false);
}

export async function shopInfo(gql: Gql): Promise<ShopInfo & { myshopifyDomain: string }> {
  const d = await gql<{ shop: { name: string; currencyCode: string; myshopifyDomain: string; primaryDomain: { url: string } } }>(
    `#graphql
    query TroothShop { shop { name currencyCode myshopifyDomain primaryDomain { url } } }`,
  );
  return { name: d.shop.name, url: d.shop.primaryDomain.url.replace(/\/+$/, ""), currencyCode: d.shop.currencyCode, myshopifyDomain: d.shop.myshopifyDomain };
}

export async function startBulkProducts(gql: Gql, query: string): Promise<string> {
  const d = await gql<{ bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { field?: string[]; message: string; code?: string }[] } }>(
    `#graphql
    mutation TroothBulkProducts($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message code }
      }
    }`,
    { query },
  );
  const r = d.bulkOperationRunQuery;
  if (r.userErrors.length || !r.bulkOperation) throw new ShopifyGraphqlError(`Shopify did not start the product export: ${r.userErrors.map((u) => u.message).join("; ") || "no operation"}.`, r.userErrors.some((u) => u.code === "OPERATION_IN_PROGRESS"));
  return r.bulkOperation.id;
}

export interface BulkStatus {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELED" | "CANCELING" | "EXPIRED" | "FAILED";
  objectCount: number;
  url: string | null;
  errorCode: string | null;
}

export async function bulkStatus(gql: Gql, id: string): Promise<BulkStatus | null> {
  const d = await gql<{ node: { id: string; status: BulkStatus["status"]; objectCount: string; url: string | null; errorCode: string | null } | null }>(
    `#graphql
    query TroothBulkStatus($id: ID!) {
      node(id: $id) { ...on BulkOperation { id status objectCount url errorCode } }
    }`,
    { id },
  );
  if (!d.node) return null;
  return { id: d.node.id, status: d.node.status, objectCount: Number(d.node.objectCount ?? 0), url: d.node.url, errorCode: d.node.errorCode };
}

const PRODUCT_FIELDS = `id legacyResourceId title handle status updatedAt onlineStoreUrl description`;
const VARIANT_FIELDS = `id legacyResourceId title sku barcode price compareAtPrice availableForSale selectedOptions { name value }`;

/** One product with all of its variants (paged 250 at a time), or null when it no longer exists. */
export async function productById(gql: Gql, gid: string): Promise<ShopifyProductNode | null> {
  let cursor: string | null = null;
  let product: ShopifyProductNode | null = null;
  do {
    const d: { product: (Omit<ShopifyProductNode, "variants"> & { variants: { nodes: ShopifyVariantNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }) | null } = await gql(
      `#graphql
      query TroothProduct($id: ID!, $cursor: String) {
        product(id: $id) {
          ${PRODUCT_FIELDS}
          variants(first: 250, after: $cursor) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { id: gid, cursor },
    );
    if (!d.product) return null;
    const { variants, ...rest } = d.product;
    if (!product) product = { ...rest, variants: [] };
    product.variants.push(...variants.nodes);
    cursor = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : null;
  } while (cursor);
  return product;
}

export async function appInstallationId(gql: Gql): Promise<string> {
  const d = await gql<{ currentAppInstallation: { id: string } }>(`#graphql
    query TroothInstallation { currentAppInstallation { id } }`);
  return d.currentAppInstallation.id;
}

/** Write the values the app embed reads: app.metafields.trooth.trooth_id and app.metafields.trooth.api_base. */
export async function setEmbedMetafields(gql: Gql, values: { trooth_id: string; api_base: string }): Promise<void> {
  const ownerId = await appInstallationId(gql);
  const d = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    `#graphql
    mutation TroothEmbedValues($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message } }
    }`,
    {
      metafields: [
        { ownerId, namespace: METAFIELD_NAMESPACE, key: "trooth_id", type: "single_line_text_field", value: values.trooth_id },
        { ownerId, namespace: METAFIELD_NAMESPACE, key: "api_base", type: "single_line_text_field", value: values.api_base },
      ],
    },
  );
  if (d.metafieldsSet.userErrors.length) throw new ShopifyGraphqlError(`Shopify did not save the app embed values: ${d.metafieldsSet.userErrors.map((u) => u.message).join("; ")}.`, false);
}

/** Remove the embed values, so the embed adds nothing once the shop is disconnected. */
export async function clearEmbedMetafields(gql: Gql): Promise<void> {
  const ownerId = await appInstallationId(gql);
  await gql(
    `#graphql
    mutation TroothEmbedClear($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
    }`,
    { metafields: ["trooth_id", "api_base"].map((key) => ({ ownerId, namespace: METAFIELD_NAMESPACE, key })) },
  );
}
