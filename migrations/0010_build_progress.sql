-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Build progress that tells the truth while a read runs (2026-10-24):
--   checked              every url the crawl has dealt with (pages, files that are not pages, failures), so
--                        "checked of found" reaches the end; "fetched" counts only the pages kept.
--   rendering_started_at when the render stage began, so the estimate measures that stage's own rate.
--   assemble_claimed_at  the render batches now run side by side and the last one to finish queues assembly;
--                        assembly claims the build with this column so it runs once, and a claim older than
--                        two minutes (an assembly that failed and is retried) can be taken again.
-- Columns only, each with a default; nothing reads them until this deploy. Reversed by
-- migrations-down/0010_build_progress.down.sql.

ALTER TABLE semanto_builds ADD COLUMN checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE semanto_builds ADD COLUMN rendering_started_at TEXT;
ALTER TABLE semanto_builds ADD COLUMN assemble_claimed_at TEXT;
