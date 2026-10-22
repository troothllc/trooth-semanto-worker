-- Semanto metadata. Bodies live in R2. Every timestamp is ISO 8601 UTC text.

CREATE TABLE IF NOT EXISTS semanto_companies (
  trooth_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  org TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic','full')),
  legal_name TEXT,
  lei TEXT,
  vlei_said TEXT,
  vlei_issuer TEXT,
  vlei_checked_at TEXT,
  current_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semanto_keys (
  kid TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL REFERENCES semanto_companies(trooth_id),
  public_jwk TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('hosted','customer')),
  nbf TEXT,
  exp TEXT,
  revoked_at TEXT,
  dns_checked_at TEXT,
  dns_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semanto_versions (
  trooth_id TEXT NOT NULL REFERENCES semanto_companies(trooth_id),
  version INTEGER NOT NULL,
  supersedes INTEGER,
  state TEXT NOT NULL CHECK (state IN ('read','confirmed','signed','withdrawn')),
  built_at TEXT NOT NULL,
  confirmed_at TEXT,
  signed_at TEXT,
  withdrawn_at TEXT,
  not_before TEXT NOT NULL,
  not_after TEXT,
  root_hash TEXT NOT NULL,
  pages_root TEXT NOT NULL,
  facts_root TEXT NOT NULL,
  tiers_json TEXT NOT NULL,
  signature_jws TEXT,
  signature_kid TEXT,
  witness_jws TEXT,
  witness_kid TEXT,
  witnessed_at TEXT,
  ledger_index INTEGER,
  ledger_tree_size INTEGER,
  ledger_tree_head TEXT,
  tsa_token_key TEXT,
  receipt_sha256 TEXT,
  page_count INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  PRIMARY KEY (trooth_id, version)
);

CREATE TABLE IF NOT EXISTS semanto_pages (
  trooth_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  original_tokens INTEGER NOT NULL,
  witnessed_at TEXT NOT NULL,
  lang TEXT,
  part_n INTEGER,
  part_of INTEGER,
  status INTEGER NOT NULL,
  noindex INTEGER NOT NULL DEFAULT 0,
  nosnippet INTEGER NOT NULL DEFAULT 0,
  canonical TEXT,
  robots_blocked INTEGER NOT NULL DEFAULT 0,
  manifest_index INTEGER NOT NULL,
  PRIMARY KEY (trooth_id, version, page_id),
  FOREIGN KEY (trooth_id, version) REFERENCES semanto_versions(trooth_id, version)
);
CREATE INDEX IF NOT EXISTS semanto_pages_url ON semanto_pages(trooth_id, url);

CREATE TABLE IF NOT EXISTS semanto_facts (
  trooth_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  fact_id TEXT NOT NULL,
  key TEXT NOT NULL,
  statement TEXT NOT NULL,
  value_json TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN ('witnessed','public_record','attested','declared')),
  evidence_url TEXT NOT NULL,
  evidence_anchor TEXT,
  evidence_source TEXT,
  witnessed_at TEXT NOT NULL,
  schema_type TEXT,
  schema_property TEXT,
  PRIMARY KEY (trooth_id, version, fact_id)
);

CREATE TABLE IF NOT EXISTS semanto_settings (
  trooth_id TEXT PRIMARY KEY REFERENCES semanto_companies(trooth_id),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semanto_host_detection (
  trooth_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  cloudflare_markdown INTEGER NOT NULL DEFAULT 0,
  well_known_served INTEGER NOT NULL DEFAULT 0,
  dns_pointer INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  details_json TEXT NOT NULL
);

-- The public log: one row per leaf; tiles and tree heads in R2.
CREATE TABLE IF NOT EXISTS semanto_log (
  idx INTEGER PRIMARY KEY,
  leaf_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  trooth_id TEXT,
  ref TEXT NOT NULL,
  appended_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS semanto_tree_heads (
  tree_size INTEGER PRIMARY KEY,
  root_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  jws TEXT NOT NULL,
  tsa_token_key TEXT,
  tsa_time TEXT
);

CREATE TABLE IF NOT EXISTS semanto_revocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trooth_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('version','key','offer','record')),
  ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  log_index INTEGER
);

CREATE TABLE IF NOT EXISTS semanto_read_receipts (
  id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  version INTEGER,
  page_id TEXT,
  representation TEXT NOT NULL,
  agent_key_url TEXT,
  agent_keyid TEXT,
  proof TEXT NOT NULL CHECK (proof IN ('web_bot_auth','none')),
  read_at TEXT NOT NULL,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS semanto_read_receipts_company ON semanto_read_receipts(trooth_id, read_at);

CREATE TABLE IF NOT EXISTS semanto_monitor_runs (
  id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  surfaces_json TEXT NOT NULL,
  mismatches_json TEXT NOT NULL,
  indexability_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semanto_alerts (
  id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS semanto_products (
  trooth_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  gtin TEXT,
  sku TEXT,
  record_json TEXT NOT NULL,
  jws TEXT,
  signed_at TEXT,
  not_after TEXT,
  withdrawn_at TEXT,
  PRIMARY KEY (trooth_id, record_id)
);
CREATE INDEX IF NOT EXISTS semanto_products_sku ON semanto_products(trooth_id, sku);

CREATE TABLE IF NOT EXISTS semanto_offers (
  trooth_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  variant_id TEXT,
  offer_json TEXT NOT NULL,
  jws TEXT NOT NULL,
  as_of TEXT NOT NULL,
  not_after TEXT NOT NULL,
  PRIMARY KEY (trooth_id, offer_id)
);
CREATE INDEX IF NOT EXISTS semanto_offers_sku ON semanto_offers(trooth_id, sku, as_of);

CREATE TABLE IF NOT EXISTS semanto_sellers (
  trooth_id TEXT NOT NULL,
  attestation_id TEXT NOT NULL,
  seller_domain TEXT NOT NULL,
  attestation_json TEXT NOT NULL,
  jws TEXT NOT NULL,
  not_after TEXT,
  withdrawn_at TEXT,
  PRIMARY KEY (trooth_id, attestation_id)
);

CREATE TABLE IF NOT EXISTS semanto_recalls (
  trooth_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  notice_json TEXT NOT NULL,
  jws TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, notice_id)
);

CREATE TABLE IF NOT EXISTS semanto_gap_reports (
  id TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('b2b','shopping','local','competitor')),
  ran_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semanto_first_publications (
  trooth_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  witnessed_at TEXT NOT NULL,
  jws TEXT NOT NULL,
  log_index INTEGER,
  PRIMARY KEY (trooth_id, record_id)
);

CREATE TABLE IF NOT EXISTS semanto_change_state (
  trooth_id TEXT NOT NULL,
  url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  raw_hash TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, url)
);
