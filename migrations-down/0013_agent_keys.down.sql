-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
-- Reverses migrations/0013_agent_keys.sql.
DROP INDEX IF EXISTS semanto_agent_keys_company;
DROP TABLE IF EXISTS semanto_agent_keys;
