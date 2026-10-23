// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The queue consumer's work, one function per job kind. A job that fails with
// a retryable error is retried by the queue after 30, 120 and 600 seconds (the
// schedule the program contract sets for Semanto's own queue); on the last
// attempt the job finishes in a defined state (a failed run with a plain
// message, or the shop's rows deleted) instead of being retried forever.

import type { SyncJob } from "./env";
import type { ShopService } from "./service.server";

export const MAX_ATTEMPTS = 4;
export const RETRY_DELAYS_SECONDS = [30, 120, 600];

export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_SECONDS[Math.min(attempt - 1, RETRY_DELAYS_SECONDS.length - 1)]!;
}

/** Run one job. `attempt` starts at 1. Throws when the queue should retry. */
export async function runJob(job: SyncJob, service: ShopService, attempt: number): Promise<void> {
  const final = attempt >= MAX_ATTEMPTS;
  switch (job.kind) {
    case "bulk_finished":
      await service.finishBulk(job.shop, job.bulk_operation_id, final);
      return;
    case "product_changed":
      try {
        await service.productChanged(job.shop, job.product_gid);
      } catch (e) {
        if (!final) throw e;
      }
      return;
    case "product_deleted":
      try {
        await service.productDeleted(job.shop, job.product_id);
      } catch (e) {
        if (!final) throw e;
      }
      return;
    case "remove_shop":
      await service.removeShop(job.shop, job.reason, final);
      return;
  }
}
