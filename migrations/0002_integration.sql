-- Semanto integration: what the pipeline (src/pipeline.ts) keeps beyond 0001.
-- Every timestamp is ISO 8601 UTC text.

-- Who holds the signing key before a first key row exists (hosted or customer).
ALTER TABLE semanto_companies ADD COLUMN custody TEXT; -- 'hosted' or 'customer'

-- The sitemap lastmod seen at the last check, for the hourly change detection.
ALTER TABLE semanto_change_state ADD COLUMN lastmod TEXT;

-- Signing policy, connected surfaces, alert addresses, gap report settings and registry facts.
CREATE TABLE IF NOT EXISTS semanto_company_config (
  trooth_id TEXT PRIMARY KEY REFERENCES semanto_companies(trooth_id),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Approvals of a built version (the two-officer rule counts distinct subjects per root hash).
CREATE TABLE IF NOT EXISTS semanto_authorizations (
  trooth_id TEXT NOT NULL,
  root_hash TEXT NOT NULL,
  subject TEXT NOT NULL,
  record_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, root_hash, subject)
);

-- Customer custody: the exact header and signing input handed out, waiting for the signature.
CREATE TABLE IF NOT EXISTS semanto_pending_signatures (
  trooth_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kid TEXT NOT NULL,
  header_json TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (trooth_id, version)
);

-- Commerce connector public keys (RFC 9421 requests, tag trooth-connector).
CREATE TABLE IF NOT EXISTS semanto_connector_keys (
  kid TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL REFERENCES semanto_companies(trooth_id),
  public_jwk TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_connector_keys_company ON semanto_connector_keys(trooth_id);

-- Semanto Basic: claim, domain proof and build state.
CREATE TABLE IF NOT EXISTS semanto_basic (
  trooth_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Signed revocation lists, re-signed nightly.
CREATE TABLE IF NOT EXISTS semanto_revocation_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trooth_id TEXT,
  jws TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
