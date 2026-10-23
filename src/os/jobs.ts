// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The queue kinds the workspace contract owns, dispatched from the pipeline's
// consumer (src/pipeline.ts consume): writeback (src/os/writeback.ts),
// recall_event (src/os/recalls.ts) and credential (src/os/credentials.ts).
// A job that should run again throws RetryLater (src/os/common.ts); the
// consumer turns it into message.retry({ delaySeconds }). Every message names
// its company and is checked against the stored row before anything is sent.

import type { CredentialMessage, RecallEventMessage, WritebackMessage } from "../env";
import { processCredential } from "./credentials";
import { processRecallEvent } from "./recalls";
import type { OsService } from "./service";
import { failWriteback, processWriteback } from "./writeback";

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** True when the message was one of these kinds (handled, or thrown for a retry). */
export async function consumeOs(s: OsService, m: Record<string, unknown>, attempts: number): Promise<boolean> {
  if (m.kind === "writeback") {
    if (str(m.trooth_id) && str(m.run_id) && str(m.item_id)) await processWriteback(s, m as unknown as WritebackMessage, attempts);
    return true;
  }
  if (m.kind === "recall_event") {
    if (str(m.trooth_id) && str(m.event_id)) await processRecallEvent(s, m as unknown as RecallEventMessage, attempts);
    return true;
  }
  if (m.kind === "credential") {
    if (str(m.trooth_id) && str(m.asset_url) && (m.source === "compile" || m.source === "writeback")) await processCredential(s, m as unknown as CredentialMessage);
    return true;
  }
  return false;
}

/** The last failed attempt of one of these kinds. */
export async function consumeOsFailed(s: OsService, m: Record<string, unknown>, e: unknown): Promise<boolean> {
  if (m.kind === "writeback") {
    if (str(m.trooth_id) && str(m.run_id) && str(m.item_id)) await failWriteback(s, m as unknown as WritebackMessage, e);
    return true;
  }
  if (m.kind === "recall_event") {
    if (str(m.event_id)) {
      const ev = await s.store.getRecallEvent(m.event_id);
      if (ev && ev.state !== "sent") await s.store.updateRecallEvent(m.event_id, { state: "failed", last_error: e instanceof Error ? e.message : "The send did not finish inside Trooth." });
    }
    return true;
  }
  return m.kind === "credential";
}
