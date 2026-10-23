// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: one app instance over the fixture D1, the fixture Trooth and
// the fixture Shopify, with a clock the test moves and an in-memory queue the
// test drains (each job runs through app/lib/jobs.server.ts with its attempt
// number, as the queue consumer runs it).

import { FixtureD1 } from "./d1";
import { MockTrooth } from "./mock-trooth";
import { MockShopify } from "./mock-shopify";
import { AppStore } from "../../app/lib/store.server";
import { TroothClient } from "../../app/lib/trooth-client";
import { ShopService } from "../../app/lib/service.server";
import { gqlFromAdmin } from "../../app/lib/shopify-admin";
import { runJob, MAX_ATTEMPTS } from "../../app/lib/jobs.server";
import type { Settings, SyncJob } from "../../app/lib/env";

export const SHOP = "fixture-shop.myshopify.com";
export const TROOTH_ID = "fixture-co";
/** 32 zero-free fixture bytes, base64; a test key, never a real one. */
export const SEAL_KEY = Buffer.from("fixture-seal-key-32-bytes-long!!").toString("base64");

export function harness(start = "2026-10-23T12:00:00Z") {
  let nowMs = Date.parse(start);
  const now = () => new Date(nowMs);
  const d1 = new FixtureD1();
  const trooth = new MockTrooth(now);
  const shopify = new MockShopify();
  const store = new AppStore(d1.asD1(), now);
  const queue: { job: SyncJob; attempts: number }[] = [];
  const settings: Settings = {
    apiKey: "fixture-client-id",
    apiSecret: "fixture-client-secret",
    appUrl: "https://shopify.trooth.test",
    appHandle: "semanto-by-trooth",
    scopes: ["read_products"],
    troothApiBase: trooth.base,
    dashboardUrl: trooth.dashboard,
    sealKey: SEAL_KEY,
  };
  const noSleep = async () => undefined;
  const client = new TroothClient(trooth.base, trooth.dashboard, (i, init) => trooth.fetch(i, init), { sleep: noSleep }, now);
  const service = new ShopService({
    store,
    settings,
    trooth: client,
    enqueue: async (job) => void queue.push({ job, attempts: 1 }),
    gqlFor: async (shop) => gqlFromAdmin({ graphql: async (q, o) => shopify.graphql(shop, q, o?.variables) }, { sleep: noSleep }),
    fetchFile: (i, init) => shopify.fetch(i, init),
    now,
  });
  /** Run queued jobs until the queue is empty; a failed job is retried with its next attempt number, up to the last. */
  const drain = async () => {
    const errors: unknown[] = [];
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await runJob(item.job, service, item.attempts);
      } catch (e) {
        errors.push(e);
        if (item.attempts < MAX_ATTEMPTS) queue.push({ job: item.job, attempts: item.attempts + 1 });
      }
    }
    return errors;
  };
  return {
    d1,
    trooth,
    shopify,
    store,
    service,
    settings,
    queue,
    drain,
    now,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** Connect SHOP to TROOTH_ID through the whole flow: connect, approve on the fixture Trooth, one poll. */
export async function connected(h: ReturnType<typeof harness>) {
  await h.service.markWelcomeDone(SHOP);
  await h.service.connect(SHOP);
  h.trooth.approve(h.trooth.latestSession().id, TROOTH_ID);
  await h.service.poll(SHOP);
}
