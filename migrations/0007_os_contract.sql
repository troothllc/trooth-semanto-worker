-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- The workspace contract of 23 October 2026 (docs/program/CONTRACT-2026-10-23.md,
-- docs/spec/os-api.md): the audit trail, staged key rotation, connector key
-- labels and their last signed request, the public connect sessions, the
-- Google connection, alert addresses, write-back runs, seller lists, recall
-- events for worker-f and C2PA credentials. Additive only: new tables, new
-- columns with defaults. The down file is migrations-down/0007_os_contract.down.sql.
-- Every timestamp is ISO 8601 UTC text. Nothing here is read on a schedule:
-- every row is written and read on demand or by a queue message.

-- One row per write through the workspace routes (the user id and the name
-- or address shown as who, role, action, target, before and after hashes,
-- request id). The company settings screen shows the
-- newest 20 as "Recent changes".
CREATE TABLE IF NOT EXISTS semanto_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trooth_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  who TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  request_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semanto_audit_company ON semanto_audit(trooth_id, id);

-- Staged rotation: a key published in the JWK Set but not yet used to sign
-- is pending (state "next"). Signing paths read only keys with pending = 0.
ALTER TABLE semanto_keys ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS semanto_key_rotations (
  rotation_id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  next_kid TEXT NOT NULL,
  current_kid TEXT,
  custody TEXT NOT NULL CHECK (custody IN ('hosted','customer')),
  state TEXT NOT NULL CHECK (state IN ('started','confirmed','cancelled')),
  overlap_until TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_key_rotations_company ON semanto_key_rotations(trooth_id, started_at);

-- Connector keys: a label, and the last signed request seen for each kid on
-- the catalog route (time and result), which the connection test reads.
ALTER TABLE semanto_connector_keys ADD COLUMN label TEXT;
ALTER TABLE semanto_connector_keys ADD COLUMN last_request_at TEXT;
ALTER TABLE semanto_connector_keys ADD COLUMN last_result TEXT;
ALTER TABLE semanto_connector_keys ADD COLUMN last_ok_at TEXT;
CREATE INDEX IF NOT EXISTS semanto_connector_keys_source ON semanto_connector_keys(trooth_id, source);

-- The public connect flow for app installs (device-flow pattern): the poll
-- token is kept only as its SHA-256.
CREATE TABLE IF NOT EXISTS semanto_connect_sessions (
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

-- Google OAuth: the state parameter is kept as its SHA-256 with the PKCE
-- verifier, for ten minutes and one use.
CREATE TABLE IF NOT EXISTS semanto_google_states (
  state_hash TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  who TEXT NOT NULL,
  role TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  products TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One Google connection per company. The refresh token is sealed with
-- AES-256-GCM (src/db/key-seal.ts, context google-refresh); it is never
-- stored or answered in the clear.
CREATE TABLE IF NOT EXISTS semanto_google_connections (
  trooth_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('connected','needs_reconnect')),
  account_email TEXT,
  products TEXT NOT NULL,
  scopes TEXT NOT NULL,
  sealed_refresh_token TEXT NOT NULL,
  merchant_accounts TEXT NOT NULL DEFAULT '[]',
  business_locations TEXT NOT NULL DEFAULT '[]',
  connected_at TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  last_refresh_at TEXT,
  last_error TEXT,
  alerted_at TEXT
);

-- Alert addresses: pending until the link in the confirmation email is
-- opened. The single-use token is kept only as its SHA-256.
CREATE TABLE IF NOT EXISTS semanto_alert_addresses (
  trooth_id TEXT NOT NULL,
  address TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed')),
  token_hash TEXT,
  token_expires_at TEXT,
  added_at TEXT NOT NULL,
  confirmed_at TEXT,
  last_sent_at TEXT,
  PRIMARY KEY (trooth_id, address)
);
CREATE UNIQUE INDEX IF NOT EXISTS semanto_alert_addresses_token ON semanto_alert_addresses(token_hash) WHERE token_hash IS NOT NULL;

-- Write-back that sends: one run per confirmed send (the idempotency key
-- answers the same run), one item per proposed change.
CREATE TABLE IF NOT EXISTS semanto_writeback_runs (
  run_id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (trooth_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS semanto_writeback_runs_company ON semanto_writeback_runs(trooth_id, created_at);

CREATE TABLE IF NOT EXISTS semanto_writeback_items (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  trooth_id TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('merchant_center','business_profile')),
  target TEXT NOT NULL,
  summary TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','failed','retrying')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, item_id)
);

-- Seller lists: only lists whose signature checked out are stored; versions
-- only go up. valid, superseded and invalid are computed on read.
CREATE TABLE IF NOT EXISTS semanto_seller_lists (
  trooth_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  jws TEXT NOT NULL,
  kid TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('hosted','customer')),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, version)
);

-- Recall events sent to worker-f's changes feed. The event id is
-- sha256(trooth_id, recall_id, content hash), so a repeat is a no-op.
CREATE TABLE IF NOT EXISTS semanto_recall_events (
  event_id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  recall_id TEXT NOT NULL,
  body_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_recall_events_company ON semanto_recall_events(trooth_id, created_at);

-- C2PA credentials made by the queue (src/c2pa/bridge.ts); the manifest is
-- in R2 under credentials/<trooth_id>/<sha256 hex>.c2pa.
CREATE TABLE IF NOT EXISTS semanto_credentials (
  trooth_id TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  sha256 TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('compile','writeback')),
  state TEXT NOT NULL CHECK (state IN ('made','failed','skipped')),
  reason TEXT,
  made_at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, asset_url)
);
CREATE INDEX IF NOT EXISTS semanto_credentials_sha ON semanto_credentials(trooth_id, sha256);
CREATE INDEX IF NOT EXISTS semanto_credentials_state ON semanto_credentials(trooth_id, state, made_at);
