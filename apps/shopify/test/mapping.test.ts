// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shopify products to the catalog document, and that document read by the
// Worker's own catalogToInputs (src/pipeline.ts): every active variant
// becomes a declared product record and an offer, a discontinued product
// becomes a discontinued offer, and parts stay under the Worker's 5 MB limit.

import { describe, expect, it } from "vitest";
import { catalogDocument, chunkProducts, digitsOnly, legacyId, mapProduct, markDiscontinued, productHash, CHUNK_MAX_BYTES } from "../app/lib/mapping";
import { BULK_PRODUCTS_QUERY, lines, readBulkProducts, type BulkReadResult } from "../app/lib/bulk";
import { fixtureProduct } from "./fixtures/mock-shopify";

const STORE = "https://fixture.example";

/**
 * The Worker's src/pipeline.ts, loaded at run time. The address is not a literal so this package's typecheck does not
 * pull the whole Worker into its program (the Worker typechecks itself); the test still runs the Worker's real code.
 */
type CatalogToInputs = (products: unknown[], ctx: { company: never; currency: string; at: string; source: string }) => {
  records: { sku: string; provenance: string; gtin?: string; variant_axes: Record<string, string> }[];
  offers: { availability: string; price: { amount: number; currency: string } }[];
  skipped: { sku: string; reason: string }[];
  removed: string[];
};
async function workerPipeline(): Promise<{ catalogToInputs: CatalogToInputs }> {
  const address = ["..", "..", "..", "src", "pipeline"].join("/");
  return (await import(/* @vite-ignore */ new URL(address, import.meta.url).href)) as { catalogToInputs: CatalogToInputs };
}
const INFO = { name: "Fixture Store", url: STORE, currencyCode: "USD" };

describe("mapping", () => {
  it("maps a single-variant product to a simple catalog product with the variant's values on it", () => {
    const p = mapProduct(fixtureProduct(1), STORE);
    expect(p).toMatchObject({ id: "1001", type: "simple", name: "Fixture Product 1", url: `${STORE}/products/fixture-product-1`, sku: "FIX-1-0", gtin: "4006381333931", price: "11.00", regular_price: "11.00", stock_status: "instock", variants: [] });
    expect(p.description).toBe("Fixture description 1");
  });

  it("maps a multi-variant product to a variable product with one entry per variant and its options as attributes", () => {
    const p = mapProduct(fixtureProduct(2, { variants: 3 }), STORE);
    expect(p.type).toBe("variable");
    expect(p.sku).toBe("");
    expect(p.variants).toHaveLength(3);
    expect(p.variants[1]).toMatchObject({ id: "5021", sku: "FIX-2-1", attributes: { Size: "S1" }, url: `${STORE}/products/fixture-product-2?variant=5021` });
  });

  it("drops Shopify's Default Title option, keeps compare-at as the regular price, and reads stock from availableForSale only", () => {
    const node = fixtureProduct(3, { available: false });
    node.variants[0]!.compareAtPrice = "20.00";
    const p = mapProduct(node, STORE);
    expect(p.regular_price).toBe("20.00");
    expect(p.stock_status).toBe("outofstock");
    expect(JSON.stringify(p)).not.toContain("Default Title");
    expect(JSON.stringify(p)).not.toMatch(/inventory|"stock":/);
  });

  it("prefers the online store address when the product is published there", () => {
    const node = fixtureProduct(4);
    node.onlineStoreUrl = "https://shop.fixture.example/products/four";
    expect(mapProduct(node, STORE).url).toBe("https://shop.fixture.example/products/four");
  });

  it("marks a product and all its variants discontinued", () => {
    const d = markDiscontinued(mapProduct(fixtureProduct(5, { variants: 2 }), STORE));
    expect(d.stock_status).toBe("discontinued");
    expect(d.variants.every((v) => v.stock_status === "discontinued")).toBe(true);
  });

  it("hashes what Trooth would receive, ignoring only the modified time", async () => {
    const a = mapProduct(fixtureProduct(6), STORE);
    const b = { ...a, modified_at: "2026-10-22T00:00:00Z" };
    const c = { ...a, price: "99.00" };
    expect(await productHash(a)).toBe(await productHash(b));
    expect(await productHash(a)).not.toBe(await productHash(c));
    expect(await productHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("builds the catalog document in the shape every connector sends", () => {
    const doc = catalogDocument("fixture-shop.myshopify.com", INFO, "fixture-co", [], new Date("2026-10-23T12:00:00.123Z"));
    expect(doc).toEqual({ source: "shopify", site: STORE, trooth_id: "fixture-co", currency: "USD", generated_at: "2026-10-23T12:00:00Z", connector: "trooth-semanto-shopify-app/0.1.0", shop: "fixture-shop.myshopify.com", products: [] });
  });

  it("splits products into parts that stay under the size limit and keeps their order", () => {
    const products = Array.from({ length: 50 }, (_, i) => mapProduct(fixtureProduct(i, { variants: 5 }), STORE));
    const parts = chunkProducts(products, 300, 8000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat().map((p) => p.id)).toEqual(products.map((p) => p.id));
    for (const part of parts) expect(new TextEncoder().encode(JSON.stringify(catalogDocument("s", INFO, "fixture-co", part))).length).toBeLessThanOrEqual(8000 + 300);
    expect(CHUNK_MAX_BYTES).toBeLessThan(5 * 1024 * 1024);
  });

  it("small helpers: digits-only GTIN and legacy ids", () => {
    expect(digitsOnly(" 0-12345-67890-5 ")).toBe("012345678905");
    expect(digitsOnly("")).toBeNull();
    expect(legacyId("gid://shopify/Product/123")).toBe("123");
    expect(legacyId(456)).toBe("456");
  });
});

describe("the Worker reads the app's catalog (src/pipeline.ts catalogToInputs)", () => {
  it("turns every variant into a declared record and an offer, with variant axes and GTINs kept", async () => {
    const { catalogToInputs } = await workerPipeline();
    const company = { trooth_id: "fixture-co", domain: "fixture.example", org: "Fixture Co" } as never;
    const products = [mapProduct(fixtureProduct(1), STORE), mapProduct(fixtureProduct(2, { variants: 2 }), STORE)];
    const out = catalogToInputs(JSON.parse(JSON.stringify(products)) as unknown[], { company, currency: "USD", at: "2026-10-23T12:00:00Z", source: "shopify" });
    expect(out.skipped).toEqual([]);
    expect(out.records.map((r) => r.sku)).toEqual(["FIX-1-0", "FIX-2-0", "FIX-2-1"]);
    expect(out.records.every((r) => r.provenance === "declared")).toBe(true);
    expect(out.records[0]!.gtin).toBe("4006381333931");
    expect(out.records[1]!.variant_axes).toEqual({ size: "S0" });
    expect(out.offers.map((o) => o.availability)).toEqual(["in_stock", "in_stock", "in_stock"]);
    expect(out.offers[0]!.price).toEqual({ amount: 1100, currency: "USD" });
  });

  it("reads a discontinued product as removed: its sku in removed and no offer", async () => {
    const { catalogToInputs } = await workerPipeline();
    const company = { trooth_id: "fixture-co", domain: "fixture.example", org: "Fixture Co" } as never;
    const out = catalogToInputs([markDiscontinued(mapProduct(fixtureProduct(7), STORE)), markDiscontinued(mapProduct(fixtureProduct(8, { variants: 2 }), STORE))] as unknown[], { company, currency: "USD", at: "2026-10-23T12:00:00Z", source: "shopify" });
    expect(out.removed).toEqual(["FIX-7-0", "FIX-8-0", "FIX-8-1"]);
    expect(out.offers).toEqual([]);
  });
});

describe("bulk operation results", () => {
  const jsonl = (rows: unknown[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const text = rows.map((r) => JSON.stringify(r)).join("\n");
        // Split mid-line to prove lines are joined across chunks.
        const bytes = new TextEncoder().encode(text);
        c.enqueue(bytes.slice(0, 37));
        c.enqueue(bytes.slice(37));
        c.close();
      },
    });

  it("the bulk query asks for active products and the fields mapping reads, without first: arguments", () => {
    expect(BULK_PRODUCTS_QUERY).toContain('products(query: "status:active")');
    expect(BULK_PRODUCTS_QUERY).not.toMatch(/first:/);
    for (const f of ["legacyResourceId", "handle", "onlineStoreUrl", "barcode", "compareAtPrice", "availableForSale", "selectedOptions"]) expect(BULK_PRODUCTS_QUERY).toContain(f);
    expect(BULK_PRODUCTS_QUERY).not.toMatch(/inventory/i);
  });

  it("joins each product with the variant lines that follow it", async () => {
    const p1 = fixtureProduct(1, { variants: 2 });
    const p2 = fixtureProduct(2);
    const rows = [p1, p2].flatMap(({ variants, ...rest }) => [rest, ...variants.map((v) => ({ ...v, __parentId: rest.id }))]);
    const result: BulkReadResult = { late: new Set(), bad: 0 };
    const out = [];
    for await (const p of readBulkProducts(lines(jsonl(rows)), result)) out.push(p);
    expect(out.map((p) => [p.id, p.variants.length])).toEqual([
      [p1.id, 2],
      [p2.id, 1],
    ]);
    expect(result).toEqual({ late: new Set(), bad: 0 });
  });

  it("reports a variant that arrives after its product was finished, and counts lines that are not JSON", async () => {
    const p1 = fixtureProduct(1, { variants: 2 });
    const p2 = fixtureProduct(2);
    const { variants: v1, ...r1 } = p1;
    const { variants: v2, ...r2 } = p2;
    const result: BulkReadResult = { late: new Set(), bad: 0 };
    const src = (async function* () {
      yield JSON.stringify(r1);
      yield JSON.stringify({ ...v1[0], __parentId: r1.id });
      yield JSON.stringify(r2);
      yield JSON.stringify({ ...v2[0], __parentId: r2.id });
      yield "{not json";
      yield JSON.stringify({ ...v1[1], __parentId: r1.id });
    })();
    const out = [];
    for await (const p of readBulkProducts(src, result)) out.push(p);
    expect(out).toHaveLength(2);
    expect(result.late).toEqual(new Set([r1.id]));
    expect(result.bad).toBe(1);
  });
});
