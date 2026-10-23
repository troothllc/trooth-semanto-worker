// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Shopify app object (@shopify/shopify-app-react-router, the package the
// official React Router template uses), built once per Worker isolate from the
// request's env. Embedded auth is Shopify's current recommendation: managed
// installation (scopes declared in shopify.app.toml, Shopify installs the app
// before it loads) and token exchange (the App Bridge session token is traded
// for an offline access token, no OAuth redirects), with expiring offline
// tokens refreshed by the library. Sessions live in D1, sealed
// (app/lib/session-storage.server.ts); there is no Postgres.
//
// The library's runtime adapter is the Cloudflare Worker one; its fetch is
// pointed at the global fetch on every call, so the Workers runtime (and the
// tests' mocked Shopify) is used.

import "@shopify/shopify-api/adapters/cf-worker";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { D1SessionStorage } from "./lib/session-storage.server";
import { settingsFrom, type Env } from "./lib/env";
import { AppStore } from "./lib/store.server";

setAbstractFetchFunc((input, init) => globalThis.fetch(input as RequestInfo, init as RequestInit));

function build(env: Env) {
  const s = settingsFrom(env);
  return shopifyApp({
    apiKey: s.apiKey,
    apiSecretKey: s.apiSecret,
    apiVersion: ApiVersion.October26,
    scopes: s.scopes,
    appUrl: s.appUrl,
    authPathPrefix: "/auth",
    sessionStorage: new D1SessionStorage(env.DB, s.sealKey),
    distribution: AppDistribution.AppStore,
    future: { expiringOfflineAccessTokens: true },
    hooks: {
      afterAuth: async ({ session }) => {
        const store = new AppStore(env.DB);
        await store.ensureShop(session.shop);
        await store.logEvent(session.shop, "authorized");
      },
    },
  });
}

export type ShopifyApp = ReturnType<typeof build>;

const cache = new WeakMap<Env, ShopifyApp>();

/** The app object for this env; the Workers runtime passes the same env object to every request of an isolate. */
export function getShopify(env: Env): ShopifyApp {
  let app = cache.get(env);
  if (!app) {
    app = build(env);
    cache.set(env, app);
  }
  return app;
}
