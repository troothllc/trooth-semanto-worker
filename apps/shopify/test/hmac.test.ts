// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shopify webhook HMAC: base64 HMAC-SHA256 of the raw body under the client
// secret, compared in constant time. The expected value below is computed
// independently with node:crypto, the way Shopify's own examples compute it.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { shopifyHmac, timingSafeEqual, verifyShopifyHmac } from "../app/lib/webhooks.server";

const SECRET = "fixture-client-secret";
const body = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe("Shopify webhook HMAC", () => {
  it("matches node:crypto's HMAC-SHA256 base64 for the same body and secret", async () => {
    const raw = '{"id":1,"shop_domain":"fixture-shop.myshopify.com"}';
    expect(await shopifyHmac(body(raw), SECRET)).toBe(createHmac("sha256", SECRET).update(raw, "utf8").digest("base64"));
  });

  it("accepts the right header and refuses a wrong secret, a changed body, a missing or malformed header", async () => {
    const raw = '{"id":1}';
    const good = createHmac("sha256", SECRET).update(raw).digest("base64");
    expect(await verifyShopifyHmac(body(raw), good, SECRET)).toBe(true);
    expect(await verifyShopifyHmac(body(raw), createHmac("sha256", "other-secret").update(raw).digest("base64"), SECRET)).toBe(false);
    expect(await verifyShopifyHmac(body('{"id":2}'), good, SECRET)).toBe(false);
    expect(await verifyShopifyHmac(body(raw), null, SECRET)).toBe(false);
    expect(await verifyShopifyHmac(body(raw), "not base64 at all!", SECRET)).toBe(false);
    expect(await verifyShopifyHmac(body(raw), good.slice(0, 20), SECRET)).toBe(false);
    expect(await verifyShopifyHmac(body(raw), good, "")).toBe(false);
  });

  it("checks the raw bytes, so re-serialized JSON with the same meaning does not pass", async () => {
    const raw = '{"a":1, "b":2}';
    const good = createHmac("sha256", SECRET).update(raw).digest("base64");
    expect(await verifyShopifyHmac(body(JSON.stringify(JSON.parse(raw))), good, SECRET)).toBe(false);
  });

  it("compares in constant time over equal lengths and refuses different lengths", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
