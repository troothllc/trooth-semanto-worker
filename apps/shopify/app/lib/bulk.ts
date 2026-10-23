// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The first sync reads the whole catalog with one Admin GraphQL bulk operation
// (shopify.dev, "Perform bulk operations with the GraphQL Admin API"): Shopify
// runs the query in the background and, when it is done, sends the
// bulk_operations/finish webhook with the operation's id; the app then
// downloads the JSONL result. There is no polling: the webhook is the event.
//
// The result is one JSON object per line. A product line has the product's
// fields; each variant follows its product as its own line with __parentId set
// to the product's id. readBulkProducts streams the lines and yields each
// product with its variants once the next product starts, so memory holds one
// product at a time. A variant whose product was already yielded (Shopify
// writes children after their parent, but does not promise they are adjacent)
// is reported in `late`, and the sync reads those products one by one.

import type { ShopifyProductNode, ShopifyVariantNode } from "./mapping";

/** The bulk query: active products with the fields mapping.ts reads. Bulk queries take connections without first:. */
export const BULK_PRODUCTS_QUERY = `{
  products(query: "status:active") {
    edges {
      node {
        id
        legacyResourceId
        title
        handle
        status
        updatedAt
        onlineStoreUrl
        description
        variants {
          edges {
            node {
              id
              legacyResourceId
              title
              sku
              barcode
              price
              compareAtPrice
              availableForSale
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}`;

/** Split a byte stream into lines, without holding the whole body. */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const last = buf.trim();
  if (last) yield last;
}

const isProductId = (id: unknown): id is string => typeof id === "string" && id.startsWith("gid://shopify/Product/");
const isVariantId = (id: unknown): id is string => typeof id === "string" && id.startsWith("gid://shopify/ProductVariant/");

export interface BulkReadResult {
  /** Product ids whose variants arrived after the product was yielded. */
  late: Set<string>;
  /** Lines that were not JSON, counted and skipped. */
  bad: number;
}

/** Yield products with their variants from bulk JSONL lines. `result` is filled as the stream is read. */
export async function* readBulkProducts(source: AsyncIterable<string>, result: BulkReadResult): AsyncGenerator<ShopifyProductNode> {
  let current: ShopifyProductNode | null = null;
  const yielded = new Set<string>();
  for await (const line of source) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      result.bad++;
      continue;
    }
    if (isProductId(row.id) && row.__parentId === undefined) {
      if (current) {
        yielded.add(current.id);
        yield current;
      }
      current = { ...(row as unknown as ShopifyProductNode), variants: [] };
      continue;
    }
    if (isVariantId(row.id) && typeof row.__parentId === "string") {
      const { __parentId, ...v } = row;
      if (current && current.id === __parentId) current.variants.push(v as unknown as ShopifyVariantNode);
      else if (yielded.has(__parentId)) result.late.add(__parentId);
      // A variant whose product line has not appeared is not part of an active product; it is skipped.
    }
  }
  if (current) yield current;
}
