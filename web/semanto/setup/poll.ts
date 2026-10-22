// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// How often the wizard reads the setup state: every 4 seconds, backing off to
// 60 (docs/spec/setup-api.md, "The wizard polls it (4 s, then backing off to
// 60 s); it never needs a check button"). The schedule restarts at 4 seconds
// whenever something the owner can see changed, so a moving progress bar or a
// DNS record that just appeared is shown within seconds; Postmark's records
// turn green on their own the same way. Pure.

import type { SetupState } from "./types";

export const POLL_SCHEDULE_MS: readonly number[] = [4_000, 8_000, 15_000, 30_000, 60_000];

export function pollDelay(attempt: number, schedule: readonly number[] = POLL_SCHEDULE_MS): number {
  const i = Math.max(0, Math.min(attempt, schedule.length - 1));
  return schedule[i]!;
}

/** What the owner can see change; a different fingerprint restarts the schedule. */
export function stateFingerprint(s: SetupState | null): string {
  if (!s) return "";
  return [
    s.step,
    s.saved_for_later,
    s.proof?.status,
    s.proof?.diagnosis.state,
    s.read?.status,
    s.read?.pages_done,
    s.read?.found,
    s.review?.confirmed_at,
    s.review?.changed_since_read,
    s.sign?.signed_at,
    s.sign?.approvals.length,
    s.install?.host,
    s.install?.checked_at,
    s.monitoring?.started_at,
  ].join("|");
}
