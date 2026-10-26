-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0011_live_pages.sql. Kept outside migrations/ so wrangler never applies it by accident;
-- run it by hand with
-- `wrangler d1 execute trooth_semanto --remote --file migrations-down/0011_live_pages.down.sql`
-- and then remove the 0011 row from d1_migrations. Deploy the Worker from before 0011 first: the newer Worker
-- reads and writes this column.

ALTER TABLE semanto_change_state DROP COLUMN prev_change_at;
