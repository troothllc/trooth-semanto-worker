// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// One place that turns the Worker's env into the app's services, used by the
// React Router loaders and actions, the webhook endpoint and the queue
// consumer alike, so every entry point runs the same code against the same
// bindings.

import type { AppLoadContext } from "react-router";
import { getShopify } from "./shopify.server";
import { settingsFrom, type Env, type SyncJob } from "./lib/env";
import { AppStore } from "./lib/store.server";
import { TroothClient } from "./lib/trooth-client";
import { ShopService } from "./lib/service.server";
import { gqlFromAdmin } from "./lib/shopify-admin";

declare module "react-router" {
  interface AppLoadContext {
    cloudflare: { env: Env; ctx: Pick<ExecutionContext, "waitUntil"> };
  }
}

export function servicesFor(env: Env) {
  const settings = settingsFrom(env);
  const store = new AppStore(env.DB);
  const shopify = getShopify(env);
  const enqueue = async (job: SyncJob) => {
    await env.SYNC_QUEUE.send(job);
  };
  const service = new ShopService({
    store,
    settings,
    trooth: new TroothClient(settings.troothApiBase, settings.dashboardUrl),
    enqueue,
    gqlFor: async (shop: string) => {
      const { admin } = await shopify.unauthenticated.admin(shop);
      return gqlFromAdmin(admin);
    },
  });
  return { settings, store, shopify, service, enqueue };
}

export function envOf(context: AppLoadContext): Env {
  return context.cloudflare.env;
}
