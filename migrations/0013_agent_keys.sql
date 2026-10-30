-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Agent keys: a company's own key for an AI agent to run Semanto through the MCP server at
-- /os/semanto/mcp or the /os API, as a Vercel or Cloudflare API token does for theirs. Only the
-- SHA-256 of the secret is kept; the secret is shown once, when a person creates it. scope is read
-- (the agent acts as a viewer) or write (the agent acts as an admin; signing, erasing and agent keys
-- stay with people). Reversed by migrations-down/0013_agent_keys.down.sql.

CREATE TABLE IF NOT EXISTS semanto_agent_keys (
  kid TEXT PRIMARY KEY,
  trooth_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  secret_sha256 TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_agent_keys_company ON semanto_agent_keys(trooth_id);
