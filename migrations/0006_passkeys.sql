-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Passkeys that release a hosted company key (W3C Web Authentication Level 3,
-- sections 7.1 and 7.2; src/identity/webauthn.ts, docs/reports/passkey-signing.md).
-- Every timestamp is ISO 8601 UTC text. Binary values are base64url text.

-- The WebAuthn user for a workspace user: a random 32-byte handle, never the
-- worker-f user id itself (Level 3, section 14.6.1, user handle contents).
CREATE TABLE IF NOT EXISTS semanto_passkey_users (
  user_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- One row per registered passkey. The public key is kept as a JWK; the
-- signature count grows with every assertion (a count that does not grow is
-- refused as a possible copy).
CREATE TABLE IF NOT EXISTS semanto_passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trooth_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL CHECK (alg IN (-7, -8, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS semanto_passkeys_user ON semanto_passkeys(user_id, created_at);

-- Single-use challenges, five minutes. A "get" challenge is bound to the
-- exact version and root hash being signed.
CREATE TABLE IF NOT EXISTS semanto_webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'get')),
  trooth_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER,
  root_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semanto_webauthn_challenges_expiry ON semanto_webauthn_challenges(expires_at);

-- The passkey assertion behind an approval: { credential_id, user_id, user_handle, checked_at }.
-- user_id stays here for the two-officer count; only user_handle goes into the signed header.
ALTER TABLE semanto_authorizations ADD COLUMN passkey_json TEXT;
