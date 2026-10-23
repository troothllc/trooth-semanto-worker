-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Fixes from the backend review of 23 October 2026
-- (trooth-semanto-worker/docs/program/reports/review-backend.md). Additive
-- only: one index. The down file is migrations-down/0002_review_fixes.down.sql.

-- At most one running first or manual sync per shop: two presses of Sync now,
-- or two checks that both saw the approval, start one bulk operation, and the
-- second is answered the running one (app/lib/store.server.ts createRun).
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_running ON sync_runs (shop) WHERE state = 'running' AND kind IN ('first', 'manual');
