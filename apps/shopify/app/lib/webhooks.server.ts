// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Every Shopify webhook arrives at POST /webhooks (shopify.app.toml declares
// the subscriptions). Each request is checked first: the X-Shopify-Hmac-Sha256
// header must be the base64 HMAC-SHA256 of the exact raw body under the app's
// client secret, compared in constant time; anything else answers 401, as
// Shopify's compliance webhook rules require. Then the delivery id is recorded
// once (Shopify may deliver a webhook more than once) and the work is queued:
// the answer goes back within Shopify's five-second limit and the queue
// consumer does the rest with retries.
//
// Compliance topics: the app holds no customer personal data (no customer,
// order or address is ever read; the only scope is read_products), so
// customers/data_request and customers/redact are answered 200 with nothing to
// return or delete. shop/redact deletes every row the app holds for the shop.

import { isShopDomain, type SyncJob } from "./env";
import type { AppStore } from "./store.server";

export const WEBHOOK_MAX_BYTES = 1024 * 1024;

const enc = new TextEncoder();

function b64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time comparison of two byte strings. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Shopify's webhook HMAC: base64(HMAC-SHA256(secret, raw body)). */
export async function shopifyHmac(rawBody: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  let s = "";
  for (const b of mac) s += String.fromCharCode(b);
  return btoa(s);
}

export async function verifyShopifyHmac(rawBody: Uint8Array<ArrayBuffer>, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const given = b64ToBytes(header);
  if (!given || given.length !== 32) return false;
  const expect = b64ToBytes(await shopifyHmac(rawBody, secret))!;
  return timingSafeEqual(given, expect);
}

export const TOPICS = {
  uninstalled: "app/uninstalled",
  dataRequest: "customers/data_request",
  customersRedact: "customers/redact",
  shopRedact: "shop/redact",
  productCreate: "products/create",
  productUpdate: "products/update",
  productDelete: "products/delete",
  bulkFinish: "bulk_operations/finish",
} as const;

export const COMPLIANCE_TOPICS = [TOPICS.dataRequest, TOPICS.customersRedact, TOPICS.shopRedact] as const;

export interface WebhookDeps {
  secret: string;
  store: AppStore;
  enqueue: (job: SyncJob) => Promise<void>;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The work a checked webhook turns into, or null when there is nothing to do. Exported for the tests. */
export function jobFor(topic: string, shop: string, payload: Record<string, unknown>): SyncJob | "remove_shop" | "redact_shop" | null {
  switch (topic) {
    case TOPICS.uninstalled:
      return "remove_shop";
    case TOPICS.shopRedact:
      return "redact_shop";
    case TOPICS.dataRequest:
    case TOPICS.customersRedact:
      return null;
    case TOPICS.productCreate:
    case TOPICS.productUpdate: {
      const gid = typeof payload.admin_graphql_api_id === "string" ? payload.admin_graphql_api_id : typeof payload.id === "number" || typeof payload.id === "string" ? `gid://shopify/Product/${payload.id}` : null;
      return gid && /^gid:\/\/shopify\/Product\/\d+$/.test(gid) ? { kind: "product_changed", shop, product_gid: gid } : null;
    }
    case TOPICS.productDelete: {
      const id = typeof payload.id === "number" || typeof payload.id === "string" ? String(payload.id) : null;
      return id && /^\d+$/.test(id) ? { kind: "product_deleted", shop, product_id: id } : null;
    }
    case TOPICS.bulkFinish: {
      const id = typeof payload.admin_graphql_api_id === "string" ? payload.admin_graphql_api_id : null;
      return id && id.startsWith("gid://shopify/BulkOperation/") ? { kind: "bulk_finished", shop, bulk_operation_id: id } : null;
    }
    default:
      return null;
  }
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return text(405, "Webhooks are POST only.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > WEBHOOK_MAX_BYTES) return text(413, "Webhook body too large.");
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > WEBHOOK_MAX_BYTES) return text(413, "Webhook body too large.");
  if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256"), deps.secret))) return text(401, "HMAC check failed.");
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shop = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  if (!isShopDomain(shop)) return text(400, "Missing or malformed shop domain.");
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    return text(400, "Body is not JSON.");
  }
  const deliveryId = (req.headers.get("x-shopify-webhook-id") ?? req.headers.get("x-shopify-event-id"))?.slice(0, 200) ?? null;
  if (deliveryId && !(await deps.store.claimWebhook(deliveryId, shop, topic))) return text(200, "Already handled.");
  const job = jobFor(topic, shop, payload);
  try {
    if (job === "remove_shop") await deps.enqueue({ kind: "remove_shop", shop, reason: "uninstalled" });
    else if (job === "redact_shop") await deps.enqueue({ kind: "remove_shop", shop, reason: "shop_redact" });
    else if (job) await deps.enqueue(job);
  } catch {
    // The work was not queued: the delivery id is given back and Shopify is told to deliver again (a 5xx), so an
    // uninstall or a shop/redact is never marked handled without its work.
    if (deliveryId) await deps.store.releaseWebhook(deliveryId);
    return text(503, "Not queued. Deliver again.");
  }
  return text(200, "OK");
}
