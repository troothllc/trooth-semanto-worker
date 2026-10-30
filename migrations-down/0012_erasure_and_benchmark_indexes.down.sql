-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0012_erasure_and_benchmark_indexes.sql. Kept outside migrations/ so wrangler never applies it
-- by accident; run it by hand with
-- `wrangler d1 execute trooth_semanto --remote --file migrations-down/0012_erasure_and_benchmark_indexes.down.sql`
-- and then remove the 0012 row from d1_migrations. The Worker works without the indexes, only slower.

DROP INDEX IF EXISTS semanto_log_company_kind;
DROP INDEX IF EXISTS semanto_read_receipts_read_at;
