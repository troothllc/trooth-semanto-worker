-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- The Shopify app's own D1 database (binding DB, database trooth-shopify-app).
-- It holds Shopify sessions, one row per installed shop with its connection to
-- Trooth, the sync runs, the last product snapshot per product (for deletes and
-- to skip unchanged updates), processed webhook ids and the app's event log.
-- No customer personal data is stored anywhere in this database. Secrets
-- (access tokens, the shop's private connector key, the poll token) are sealed
-- with AES-256-GCM before they are written. The down file is
-- migrations-down/0001_shopify_app.down.sql.

CREATE TABLE IF NOT EXISTS shopify_sessions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  is_online INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  sealed TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shopify_sessions_shop ON shopify_sessions (shop);

CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL,
  welcome_done INTEGER NOT NULL DEFAULT 0,
  -- none | pending | connected
  conn_state TEXT NOT NULL DEFAULT 'none',
  trooth_id TEXT,
  kid TEXT,
  public_jwk TEXT,
  private_jwk_sealed TEXT,
  session_id TEXT,
  poll_token_sealed TEXT,
  approve_url TEXT,
  session_expires_at TEXT,
  connected_at TEXT,
  last_denied_at TEXT,
  -- unknown | active | inactive | skipped
  embed_state TEXT NOT NULL DEFAULT 'unknown',
  embed_checked_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  -- first | manual | webhook
  kind TEXT NOT NULL,
  -- running | done | failed
  state TEXT NOT NULL,
  bulk_operation_id TEXT,
  steps TEXT NOT NULL,
  products INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  offers INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  signed INTEGER,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_shop ON sync_runs (shop, started_at);
CREATE INDEX IF NOT EXISTS sync_runs_bulk ON sync_runs (bulk_operation_id);

CREATE TABLE IF NOT EXISTS products (
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  doc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop, product_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  topic TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events (received_at);
CREATE INDEX IF NOT EXISTS webhook_events_shop ON webhook_events (shop);

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_events_shop ON app_events (shop, at);
