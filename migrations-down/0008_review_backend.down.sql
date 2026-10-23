-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0008_review_backend.sql. Kept outside migrations/ so
-- wrangler never applies it by accident; run it by hand with
-- `wrangler d1 execute trooth_semanto --file migrations-down/0008_review_backend.down.sql`
-- and then remove the 0008 row from d1_migrations.

DROP INDEX IF EXISTS semanto_audit_action;
DROP INDEX IF EXISTS semanto_key_rotations_started;
