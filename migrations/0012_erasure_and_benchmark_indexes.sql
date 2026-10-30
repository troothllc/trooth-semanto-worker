-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Two indexes, no table change:
--   semanto_read_receipts(read_at)   the nightly 30-day prune and the public benchmark read by time across
--                                    every company; without it each would scan the whole table.
--   semanto_log(trooth_id, kind)     an erased company's id is never given again (src/pipeline-setup.ts
--                                    chooseTroothId asks for its erasure leaf).
-- Reversed by migrations-down/0012_erasure_and_benchmark_indexes.down.sql.

CREATE INDEX IF NOT EXISTS semanto_read_receipts_read_at ON semanto_read_receipts(read_at);
CREATE INDEX IF NOT EXISTS semanto_log_company_kind ON semanto_log(trooth_id, kind);
