-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0010_build_progress.sql. Kept outside migrations/ so
-- wrangler never applies it by accident; run it by hand with
-- `wrangler d1 execute trooth_semanto --remote --file migrations-down/0010_build_progress.down.sql`
-- and then remove the 0010 row from d1_migrations. Deploy the Worker from before
-- 0010 first: the newer Worker writes these columns.

ALTER TABLE semanto_builds DROP COLUMN assemble_claimed_at;
ALTER TABLE semanto_builds DROP COLUMN rendering_started_at;
ALTER TABLE semanto_builds DROP COLUMN checked;
