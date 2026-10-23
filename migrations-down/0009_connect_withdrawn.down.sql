-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0009_connect_withdrawn.sql. Kept outside migrations/ so
-- wrangler never applies it by accident; run it by hand with
-- `wrangler d1 execute trooth_semanto --file migrations-down/0009_connect_withdrawn.down.sql`
-- and then remove the 0009 row from d1_migrations. A withdrawn request goes
-- back to denied, the only state the older table holds for it.

CREATE TABLE semanto_connect_sessions_0007 (
  session_id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL,
  app TEXT NOT NULL,
  account TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  kid TEXT NOT NULL,
  return_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied')),
  trooth_id TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
INSERT INTO semanto_connect_sessions_0007 (session_id, poll_token_hash, app, account, public_jwk, kid, return_url, state, trooth_id, requested_at, expires_at, decided_at, decided_by)
  SELECT session_id, poll_token_hash, app, account, public_jwk, kid, return_url, CASE state WHEN 'withdrawn' THEN 'denied' ELSE state END, trooth_id, requested_at, expires_at, decided_at, decided_by FROM semanto_connect_sessions;
DROP TABLE semanto_connect_sessions;
ALTER TABLE semanto_connect_sessions_0007 RENAME TO semanto_connect_sessions;
