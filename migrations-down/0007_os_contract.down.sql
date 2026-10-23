-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0007_os_contract.sql. Kept outside migrations/ so
-- wrangler never applies it by accident; run it by hand with
-- `wrangler d1 execute trooth_semanto --file migrations-down/0007_os_contract.down.sql`
-- and then remove the 0007 row from d1_migrations. The tables it drops hold
-- only what 0007 added; the columns it drops were added by 0007.

DROP INDEX IF EXISTS semanto_credentials_state;
DROP INDEX IF EXISTS semanto_credentials_sha;
DROP TABLE IF EXISTS semanto_credentials;
DROP INDEX IF EXISTS semanto_recall_events_company;
DROP TABLE IF EXISTS semanto_recall_events;
DROP TABLE IF EXISTS semanto_seller_lists;
DROP TABLE IF EXISTS semanto_writeback_items;
DROP INDEX IF EXISTS semanto_writeback_runs_company;
DROP TABLE IF EXISTS semanto_writeback_runs;
DROP INDEX IF EXISTS semanto_alert_addresses_token;
DROP TABLE IF EXISTS semanto_alert_addresses;
DROP TABLE IF EXISTS semanto_google_connections;
DROP TABLE IF EXISTS semanto_google_states;
DROP TABLE IF EXISTS semanto_connect_sessions;
DROP INDEX IF EXISTS semanto_connector_keys_source;
ALTER TABLE semanto_connector_keys DROP COLUMN last_ok_at;
ALTER TABLE semanto_connector_keys DROP COLUMN last_result;
ALTER TABLE semanto_connector_keys DROP COLUMN last_request_at;
ALTER TABLE semanto_connector_keys DROP COLUMN label;
DROP INDEX IF EXISTS semanto_key_rotations_company;
DROP TABLE IF EXISTS semanto_key_rotations;
ALTER TABLE semanto_keys DROP COLUMN pending;
DROP INDEX IF EXISTS semanto_audit_company;
DROP TABLE IF EXISTS semanto_audit;
