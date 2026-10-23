// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: the slice of Shopify the app talks to, in memory. The Admin
// GraphQL endpoint answers the app's named operations (TroothShop,
// TroothBulkProducts, TroothBulkStatus, TroothProduct, TroothInstallation,
// TroothEmbedValues, TroothEmbedClear) from a product list; a bulk operation
// finishes when the test says so and its JSONL result is served the way
// Shopify writes it (each variant on its own line with __parentId); token
// exchange answers an expiring offline token. Fixture store and products only.

import type { ShopifyProductNode } from "../../app/lib/mapping";

export interface BulkOp {
  id: string;
  shop: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED";
  objectCount: number;
  url: string | null;
  errorCode: string | null;
}

export class MockShopify {
  readonly products = new Map<string, Map<string, ShopifyProductNode>>();
  readonly metafields = new Map<string, Map<string, string>>();
  readonly bulkOps = new Map<string, BulkOp>();
  readonly files = new Map<string, string>();
  readonly operations: { shop: string; name: string }[] = [];
  /** Answer the next N GraphQL calls as throttled. */
  throttleNext = 0;
  /** Make bulkOperationRunQuery answer that another operation is running. */
  bulkBusy = false;
  /** Write variants out of order (a variant after the next product line) in the JSONL file. */
  shuffleJsonl = false;
  private seq = 0;

  shopName(shop: string): string {
    return `Fixture Store ${shop.split(".")[0]}`;
  }

  setProducts(shop: string, list: ShopifyProductNode[]): void {
    this.products.set(shop, new Map(list.map((p) => [p.id, p])));
  }

  upsert(shop: string, p: ShopifyProductNode): void {
    if (!this.products.has(shop)) this.products.set(shop, new Map());
    this.products.get(shop)!.set(p.id, p);
  }

  remove(shop: string, gid: string): void {
    this.products.get(shop)?.delete(gid);
  }

  /** Mark a bulk operation done and write its JSONL file. */
  completeBulk(id: string): BulkOp {
    const op = this.bulkOps.get(id)!;
    const active = [...(this.products.get(op.shop)?.values() ?? [])].filter((p) => (p.status ?? "ACTIVE") === "ACTIVE");
    const rows: string[] = [];
    const late: string[] = [];
    active.forEach((p, i) => {
      const { variants, ...rest } = p;
      rows.push(JSON.stringify(rest));
      variants.forEach((v, j) => {
        const line = JSON.stringify({ ...v, __parentId: p.id });
        if (this.shuffleJsonl && i === 0 && j === variants.length - 1) late.push(line);
        else rows.push(line);
      });
    });
    rows.push(...late);
    if (active.length) {
      const url = `https://storage.shopify.test/bulk/${encodeURIComponent(id)}.jsonl`;
      this.files.set(url, rows.join("\n") + "\n");
      op.url = url;
    }
    op.status = "COMPLETED";
    op.objectCount = rows.length;
    return op;
  }

  failBulk(id: string, code = "INTERNAL_SERVER_ERROR"): void {
    const op = this.bulkOps.get(id)!;
    op.status = "FAILED";
    op.errorCode = code;
  }

  /** The GraphQL endpoint for one shop. */
  graphql(shop: string, query: string, variables: Record<string, unknown> = {}): Response {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    this.operations.push({ shop, name });
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    }
    const ok = (data: unknown) => Response.json({ data });
    switch (name) {
      case "TroothShop":
        return ok({ shop: { name: this.shopName(shop), currencyCode: "USD", myshopifyDomain: shop, primaryDomain: { url: `https://${shop.split(".")[0]}.example` } } });
      case "TroothBulkProducts": {
        if (this.bulkBusy) return ok({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ field: null, message: "A bulk query operation for this app and shop is already in progress", code: "OPERATION_IN_PROGRESS" }] } });
        const id = `gid://shopify/BulkOperation/${++this.seq}`;
        this.bulkOps.set(id, { id, shop, status: "RUNNING", objectCount: 0, url: null, errorCode: null });
        return ok({ bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } });
      }
      case "TroothBulkStatus": {
        const op = this.bulkOps.get(String(variables.id));
        return ok({ node: op ? { id: op.id, status: op.status, objectCount: String(op.objectCount), url: op.url, errorCode: op.errorCode } : null });
      }
      case "TroothProduct": {
        const p = this.products.get(shop)?.get(String(variables.id));
        if (!p) return ok({ product: null });
        const all = p.variants;
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const page = all.slice(start, start + 250);
        const next = start + 250 < all.length;
        const { variants: _v, ...rest } = p;
        return ok({ product: { ...rest, variants: { nodes: page, pageInfo: { hasNextPage: next, endCursor: next ? String(start + 250) : null } } } });
      }
      case "TroothInstallation":
        return ok({ currentAppInstallation: { id: `gid://shopify/AppInstallation/${shop.split(".")[0]}` } });
      case "TroothEmbedValues": {
        const m = this.metafields.get(shop) ?? new Map<string, string>();
        for (const f of variables.metafields as { namespace: string; key: string; value: string }[]) m.set(`${f.namespace}.${f.key}`, f.value);
        this.metafields.set(shop, m);
        return ok({ metafieldsSet: { metafields: [], userErrors: [] } });
      }
      case "TroothEmbedClear": {
        const m = this.metafields.get(shop);
        for (const f of variables.metafields as { namespace: string; key: string }[]) m?.delete(`${f.namespace}.${f.key}`);
        return ok({ metafieldsDelete: { deletedMetafields: [], userErrors: [] } });
      }
      default:
        return Response.json({ errors: [{ message: `fixture does not know ${name}` }] });
    }
  }

  /** Every Shopify address the app may call: the Admin GraphQL endpoint, token exchange and bulk result files. */
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const graphqlPath = /^\/admin\/api\/[\d-]+\/graphql\.json$/.exec(url.pathname);
    if (graphqlPath) {
      const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
      return this.graphql(url.host, body.query, body.variables);
    }
    if (url.pathname === "/admin/oauth/access_token") {
      return Response.json({ access_token: `shpat_fixture_${url.host.split(".")[0]}`, scope: "read_products", expires_in: 3600, refresh_token: "shprt_fixture", refresh_token_expires_in: 7776000 });
    }
    if (this.files.has(input)) return new Response(this.files.get(input)!, { status: 200, headers: { "content-type": "application/jsonl" } });
    return new Response("not found", { status: 404 });
  }
}

/** A product node in the shape the Admin API returns, with fixture values. */
export function fixtureProduct(n: number, opts: { variants?: number; status?: string; barcode?: string | null; available?: boolean } = {}): ShopifyProductNode {
  const count = opts.variants ?? 1;
  return {
    id: `gid://shopify/Product/${1000 + n}`,
    legacyResourceId: String(1000 + n),
    title: `Fixture Product ${n}`,
    handle: `fixture-product-${n}`,
    status: opts.status ?? "ACTIVE",
    updatedAt: "2026-10-20T10:00:00Z",
    onlineStoreUrl: null,
    description: `Fixture description ${n}`,
    variants: Array.from({ length: count }, (_, j) => ({
      id: `gid://shopify/ProductVariant/${5000 + n * 10 + j}`,
      legacyResourceId: String(5000 + n * 10 + j),
      title: count > 1 ? `Size ${j}` : "Default Title",
      sku: `FIX-${n}-${j}`,
      barcode: opts.barcode === undefined ? "4006381333931" : opts.barcode,
      price: `${10 + n}.00`,
      compareAtPrice: null,
      availableForSale: opts.available ?? true,
      selectedOptions: count > 1 ? [{ name: "Size", value: `S${j}` }] : [{ name: "Title", value: "Default Title" }],
    })),
  };
}
