-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Fixes from the backend review of 23 October 2026
-- (docs/program/reports/review-backend.md). Additive only: two indexes. The
-- down file is migrations-down/0008_review_backend.down.sql. Nothing here is
-- read on a schedule.

-- At most one started key rotation per company: two starts at the same moment
-- can no longer both publish a next key (src/os/keys.ts startRotation, through
-- D1OsStore.beginRotation, an insert with ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS semanto_key_rotations_started ON semanto_key_rotations(trooth_id) WHERE state = 'started';

-- The settings answer's updated_at reads the newest settings.save row for the
-- company directly, however many other writes came after it.
CREATE INDEX IF NOT EXISTS semanto_audit_action ON semanto_audit(trooth_id, action, id);
