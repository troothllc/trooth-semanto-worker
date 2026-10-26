-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Live pages (2026-10-25). prev_change_at is when a page's words changed before the most recent change
-- (checked_at). Two changes within 48 hours mark a page live (a status page, a live count): its changes are
-- still recorded every hour, but they no longer start a new version on their own (src/pipeline.ts
-- checkCompanyChanges). One nullable column; nothing reads it before this deploy, and it adds no cron or
-- polling. Reversed by migrations-down/0011_live_pages.down.sql.

ALTER TABLE semanto_change_state ADD COLUMN prev_change_at TEXT;
