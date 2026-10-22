-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Pre-deploy audit fixes (docs/reports/audit-fixes.md) and the setup flow
-- (docs/spec/setup-api.md). Every timestamp is ISO 8601 UTC text.

-- Finding 19: seed the log frontier, so no reader can race the first append
-- and write size 0 back over it. The LogDO is then the only writer.
INSERT OR IGNORE INTO semanto_log_frontier (id, size, nodes) VALUES (1, 0, '[]');

-- Findings 1 and 2: the domain is fixed at the claim and proven against that
-- domain; nothing is published, served or witnessed until it is proven.
ALTER TABLE semanto_companies ADD COLUMN domain_proven_at TEXT;
ALTER TABLE semanto_companies ADD COLUMN domain_proof_method TEXT; -- 'dns_txt' or 'well_known'

-- The setup wizard's server-side state (steps, timestamps, proof challenge,
-- saved for later), one row per company.
CREATE TABLE IF NOT EXISTS semanto_setup (
  trooth_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Finding 4: a build is split into queue messages of at most 25 pages. These
-- tables hold the build while it runs: the build itself, the pages discovery
-- fetched (bodies in R2), the plan in discovery order, and each rendered page
-- (manifest entries, facts, descriptions). Rows are removed after assembly.
CREATE TABLE IF NOT EXISTS semanto_builds (
  build_id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','reading','rendering','assembling','done','failed')),
  job_json TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  planned INTEGER NOT NULL DEFAULT 0,
  rendered INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  error TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_builds_company ON semanto_builds(trooth_id, requested_at);

CREATE TABLE IF NOT EXISTS semanto_build_fetched (
  build_id TEXT NOT NULL,
  url TEXT NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (build_id, url)
);

CREATE TABLE IF NOT EXISTS semanto_build_items (
  build_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  PRIMARY KEY (build_id, seq)
);

CREATE TABLE IF NOT EXISTS semanto_build_rendered (
  build_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (build_id, seq)
);

-- Finding 8: read receipts are counted per minute in the RateLimitDO and
-- written in one batch; a row now stands for every read of the same key in
-- one minute (same company, version, page, representation, proof, agent and
-- address hash).
ALTER TABLE semanto_read_receipts ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE semanto_read_receipts ADD COLUMN minute TEXT;

-- Finding 6: a version or key revocation links to its leaf in the public log.
CREATE INDEX IF NOT EXISTS semanto_revocations_company ON semanto_revocations(trooth_id, revoked_at);
