// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker's two handlers, built around a React Router request handler:
// fetch sends POST /webhooks to the webhook handler (HMAC first) and every
// other request to React Router; queue runs the slow work with retries
// (30, 120, 600 seconds) and settles each job on its last attempt. There is
// no scheduled handler: the app runs no cron. workers/app.ts passes the
// built React Router app in; the tests pass a stub and drive the same code.

import { servicesFor } from "./context.server";
import { handleWebhook } from "./lib/webhooks.server";
import { runJob, retryDelay, MAX_ATTEMPTS } from "./lib/jobs.server";
import type { Env, SyncJob } from "./lib/env";

type RequestHandler = (request: Request, context: { cloudflare: { env: Env; ctx: Pick<ExecutionContext, "waitUntil"> } }) => Promise<Response>;

export interface QueueMessageLike {
  body: SyncJob;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export function makeWorker(requestHandler: RequestHandler) {
  return {
    async fetch(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/webhooks") {
        const { settings, store, enqueue } = servicesFor(env);
        return handleWebhook(request, { secret: settings.apiSecret, store, enqueue });
      }
      return requestHandler(request, { cloudflare: { env, ctx } });
    },

    async queue(batch: { messages: readonly QueueMessageLike[] }, env: Env): Promise<void> {
      const { service } = servicesFor(env);
      for (const msg of batch.messages) {
        try {
          await runJob(msg.body, service, msg.attempts);
          msg.ack();
        } catch (e) {
          console.error(JSON.stringify({ at: new Date().toISOString(), job: msg.body.kind, shop: msg.body.shop, attempt: msg.attempts, error: e instanceof Error ? e.message : String(e) }));
          if (msg.attempts >= MAX_ATTEMPTS) msg.ack();
          else msg.retry({ delaySeconds: retryDelay(msg.attempts) });
        }
      }
    },
  };
}
