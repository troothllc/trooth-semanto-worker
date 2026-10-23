-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0002_review_fixes.sql. Kept outside migrations/ so
-- wrangler never applies it by accident; run it by hand with
-- `wrangler d1 execute trooth-shopify-app --file migrations-down/0002_review_fixes.down.sql`
-- and then remove the 0002 row from d1_migrations.

DROP INDEX IF EXISTS sync_runs_one_running;
