-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Review fixes (docs/reports/review-fixes.md).
--
-- Finding 16: the public log's compact range (the right edge of the RFC 6962
-- tree: perfect subtree roots, largest first, as [height, hex] pairs), so an
-- append is O(log n) and never reads every leaf. One row; appends are
-- serialized by the LogDO Durable Object. A log that predates this table is
-- backfilled once from semanto_log by src/ledger/store-d1.ts.
CREATE TABLE IF NOT EXISTS semanto_log_frontier (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  size INTEGER NOT NULL,
  nodes TEXT NOT NULL
);

-- Finding 8: the worker-f user who registered or claimed the company. When
-- worker-f's session answer carries no explicit workspace role, a vendor
-- session is the owner only if its userId is this one; every other vendor
-- session is a member.
ALTER TABLE semanto_companies ADD COLUMN os_owner_user_id TEXT;

-- Finding 15: the Semanto Basic record Trooth witnessed (state read, witness
-- statement and a witness log leaf, no company signature). The public routes
-- serve it, marked witnessed-not-signed, while the company has no signed
-- version.
ALTER TABLE semanto_companies ADD COLUMN basic_version INTEGER;

-- Finding 17: the whole first-publication record (the witnessed url,
-- content_hash and witnessed_at, the declared block, the JWS, the leaf and its
-- log position), so GET /public/semanto/first-publication/{smb_id} answers it
-- exactly as signed.
ALTER TABLE semanto_first_publications ADD COLUMN record_json TEXT;
