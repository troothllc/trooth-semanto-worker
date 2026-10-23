// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker's bindings and settings, by name, and the constants every module
// shares. Values live in wrangler.toml (vars) and Cloudflare secrets; nothing
// here holds a value that is a secret. The settings are read once per request
// through settingsFrom(), which applies the defaults and refuses a missing
// secret with a plain message, the way the Semanto Worker reads its own env.

/** The queue message the app sends itself: every slow piece of work runs in the queue consumer, never in a webhook answer. */
export type SyncJob =
  | { kind: "bulk_finished"; shop: string; bulk_operation_id: string }
  | { kind: "product_changed"; shop: string; product_gid: string }
  | { kind: "product_deleted"; shop: string; product_id: string }
  | { kind: "remove_shop"; shop: string; reason: "uninstalled" | "shop_redact" };

export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SHOPIFY_APP_HANDLE?: string;
  SCOPES?: string;
  TROOTH_API_BASE?: string;
  TROOTH_DASHBOARD_URL?: string;
  APP_SEAL_KEY: string;
}

export interface Settings {
  apiKey: string;
  apiSecret: string;
  appUrl: string;
  appHandle: string;
  scopes: string[];
  troothApiBase: string;
  dashboardUrl: string;
  sealKey: string;
}

/** The one access scope the app asks for (submission/app-configuration.md says why each other scope is not needed). */
export const DEFAULT_SCOPES = ["read_products"];
/** The theme app extension's embed block file name, blocks/trooth-head.liquid, used in the activation deep link. */
export const EMBED_BLOCK_HANDLE = "trooth-head";
/** The app-owned metafield namespace on the app installation that the embed block reads (app.metafields.trooth). */
export const METAFIELD_NAMESPACE = "trooth";
/** The Admin GraphQL version, the same as webhooks.api_version in shopify.app.toml. */
export const ADMIN_API_VERSION = "2026-10";
/** The name the app sends as the catalog's connector field. */
export const CONNECTOR_NAME = "trooth-semanto-shopify-app/0.1.0";

export class MissingSetting extends Error {}

export function settingsFrom(env: Env): Settings {
  const need = (name: keyof Env): string => {
    const v = env[name];
    if (typeof v !== "string" || v === "") throw new MissingSetting(`${String(name)} is not set. Add it to wrangler.toml (vars) or as a secret with wrangler secret put ${String(name)}.`);
    return v;
  };
  return {
    apiKey: need("SHOPIFY_API_KEY"),
    apiSecret: need("SHOPIFY_API_SECRET"),
    appUrl: need("SHOPIFY_APP_URL").replace(/\/+$/, ""),
    appHandle: env.SHOPIFY_APP_HANDLE || "semanto-by-trooth",
    scopes: env.SCOPES ? env.SCOPES.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SCOPES,
    troothApiBase: (env.TROOTH_API_BASE || "https://api.trooth.co").replace(/\/+$/, ""),
    dashboardUrl: (env.TROOTH_DASHBOARD_URL || "https://trooth.co/dashboard/semanto").replace(/\/+$/, ""),
    sealKey: need("APP_SEAL_KEY"),
  };
}

/** A shop domain as Shopify sends it: lowercase letters, digits and hyphens, then .myshopify.com. */
export function isShopDomain(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(s);
}

/** A Trooth ID as the Worker issues it (src/core/ids.ts isTroothId): lowercase letters, digits and hyphens. */
export function isTroothId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
}
