-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- A connect request the app withdrew (uninstalled or disconnected before the
-- merchant approved) is its own state, "withdrawn", not "denied": the merchant
-- did not refuse it. SQLite cannot change a CHECK constraint in place, so the
-- table is rebuilt with every row and column kept.

CREATE TABLE semanto_connect_sessions_0009 (
  session_id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL,
  app TEXT NOT NULL,
  account TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  kid TEXT NOT NULL,
  return_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','withdrawn')),
  trooth_id TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
INSERT INTO semanto_connect_sessions_0009 (session_id, poll_token_hash, app, account, public_jwk, kid, return_url, state, trooth_id, requested_at, expires_at, decided_at, decided_by)
  SELECT session_id, poll_token_hash, app, account, public_jwk, kid, return_url, state, trooth_id, requested_at, expires_at, decided_at, decided_by FROM semanto_connect_sessions;
DROP TABLE semanto_connect_sessions;
ALTER TABLE semanto_connect_sessions_0009 RENAME TO semanto_connect_sessions;
CREATE INDEX IF NOT EXISTS semanto_connect_sessions_kid ON semanto_connect_sessions(kid, state);
