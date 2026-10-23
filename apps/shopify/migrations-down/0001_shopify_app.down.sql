-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
-- Copyright (c) 2026 Trooth, LLC
--
-- Reverses migrations/0001_shopify_app.sql. Kept outside wrangler's
-- migrations folder so it is never applied by accident; run it by hand with
-- wrangler d1 execute trooth-shopify-app --file migrations-down/0001_shopify_app.down.sql

DROP INDEX IF EXISTS app_events_shop;
DROP TABLE IF EXISTS app_events;
DROP INDEX IF EXISTS webhook_events_shop;
DROP INDEX IF EXISTS webhook_events_received;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS products;
DROP INDEX IF EXISTS sync_runs_bulk;
DROP INDEX IF EXISTS sync_runs_shop;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS shops;
DROP INDEX IF EXISTS shopify_sessions_shop;
DROP TABLE IF EXISTS shopify_sessions;
