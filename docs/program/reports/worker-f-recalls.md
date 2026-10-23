# Item 5: recalls into worker-f's company changes feed

Repo: /home/claude/trooth-os-worker-f (branch semanto-domain-claims, nothing committed or pushed).

## Where the feed rows came from (traced)

- `GET /v1/facts/changes` (src/facts.ts): a projection computed on read from worker-f's own D1 (`native_integration_evidence`), tenant-scoped by the credential (`facts:read`). It had no cursor and no sequence.
- MCP `trooth_company_changes` (src/mcp.ts): reads trooth.co, not worker-f: `https://trooth.co/api/network/profile/history` (record versions, trooth.co's Postgres) and `https://trooth.co/api/network/profile` (per-fact edit history). Reached by both MCP transports (Streamable HTTP and the HTTP+SSE session), both through `runTool`.
- Neither path reads Neon from worker-f. Recalls are stored in worker-f's D1 and merged into both answers by worker-f, so trooth.co and Neon are untouched and no read wakes Neon.

## Route

`POST /internal/semanto/recall-events` (src/semanto-recall-events.ts, mounted in src/index.ts before the routers mounted at "/").

- Reachable only through the service binding: the URL must be `https://os/internal/semanto/recall-events`; the existing /internal host gate answers 404 on any other host (test included).
- Auth: `Trooth-Event-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `t.body` with `SEMANTO_EVENTS_SECRET`, five-minute tolerance both ways, constant-time compare over every v1 value (several v1 values accepted, so the secret can be rolled).
- Without the secret: 503 `not_configured`, "Recall events are not accepted yet: SEMANTO_EVENTS_SECRET is not set on this Worker, so no event can be checked. Nothing was stored."
- Body: `application/json` only (415), 64 KiB cap read from the stream (413), JSON (400 `bad_json`), zod schema with field paths in `issues` (400 `bad_request`).
- Rate limit: `rateLimitedShared` (the D1 limiter the other shared limits use), 120 events a minute per `os_company_id`, 429 with `retry-after: 60`.
- Audit: one `app_audit_log` row per stored change (`semanto.recall_change_stored`, the workspace's own log, src/write-audit.ts `recordAudit`), identifiers only, no recall text. Refused signatures are logged with `console.warn` (no workspace to attribute them to).
- Answers: 201 `{ object: "semanto.recall_event", duplicate: false, event_id, sequence }`; 200 with the same members and `duplicate: true` and the stored `sequence` for a repeated `event_id`.

## Storage, ordering, idempotency, cursor

- Table `semanto_recall_changes`, `seq INTEGER PRIMARY KEY AUTOINCREMENT` (never reused or lowered, even after a delete), `event_id TEXT NOT NULL UNIQUE`, indexes `(os_company_id, seq)` and `(domain, seq)`. Insert is `ON CONFLICT(event_id) DO NOTHING RETURNING seq`.
- A changed recall has a new `event_id` and is a new change after the first.
- Cursor: opaque base64url `{v:1,k:"recall",s:seq}`; a page is `seq > cursor ORDER BY seq ASC`. `next_cursor` is never null (the poll position), so a new recall always lands after a cursor an agent holds and earlier pages never move. Forged cursors are refused (400 on REST, bad_input on MCP).
- Table created on the first event (`schemaOnce` key `semanto-recalls`, version `2026-10-23.1`). Reads before any event find no table and answer an empty page without creating anything.

## Feed paths that now carry recalls

1. `GET https://api.trooth.co/v1/facts/changes?cursor=<next_cursor>&limit=<1..200>` (workspace credential; API keys DPoP-bound as before). Adds `recalls` (oldest first after `cursor`), `next_cursor`, `has_more`. `changes` and `total` are unchanged, so trooth-web's `fetchFactChanges` keeps working.
2. MCP tool `trooth_company_changes` at `https://api.trooth.co/public/mcp` (Streamable HTTP and HTTP+SSE). New optional input `recall_cursor`; `changes` gains `recalls`, `recall_cursor` (never null), `recalls_more`. Recalls are shown on the published record whose `domain` equals the event's `domain`; listed in the answered and not_served branches; summary text lists each recall with its provenance word.

Item shape on both: `{ kind: "recall", sequence, event_id, trooth_id, recall_id, product_record_id, gtin, title, hazard, remedy, published_at, source_url, provenance, emitted_at, recorded_at }`, provenance word exactly as sent (witnessed, public_record, attested, declared).

## Contract change (CONTRACT-2026-10-23.md section 5, edited in this change)

- `domain` added to the event body, required: the company's proven domain (`semanto_companies.domain` with `domain_proven_at`). The public MCP feed is keyed by domain and worker-f has no trusted domain for a workspace without a Neon read; the Semanto Worker already holds the proven one.
- The URL host `os`, content type, field limits, answer codes and the two feed shapes are written there for the sender.

## Migration (reversible, no waker)

- Up: `migrations/008_semanto_recall_changes.sql` (same statements as `ensureRecallSchema`, optional to apply, as with 007).
- Down: `migrations-down/008_semanto_recall_changes.down.sql` (drops both indexes and the table, deletes the `semanto-recalls` schemaOnce marker so the next event recreates the table). Kept outside `migrations/`.
- No trigger, no cron (wrangler.toml crons unchanged, asserted), no polling. Writes only when an event arrives; reads are one indexed SELECT inside requests that already happen. No Neon or service setting changed.

## Env names

- `SEMANTO_EVENTS_SECRET` (secret, worker-f; the same value on the Semanto Worker). Added to the Bindings type in src/index.ts. Not set by this change.

## Files changed (worker-f)

- New: `src/semanto-recall-events.ts`, `test/semanto-recall-events.test.ts`, `migrations/008_semanto_recall_changes.sql`, `migrations-down/008_semanto_recall_changes.down.sql`.
- Edited: `src/index.ts` (route, binding type), `src/facts.ts` (cursor, limit, recalls), `src/mcp.ts` (input `recall_cursor`, output schema, description, recall read and text), `src/mcp-tool-policy.json` (`recall_cursor` cap 512), `src/mcp-policy.ts` (outbound line names the local read).
- Regenerated with the repo's own generators: `test/schema-versions.json` (`node scripts/schema-digests.mjs --write`), `migrations/derived-schema.sql` and `.json` (`node scripts/derive-schema.mjs`), `registry/mcp-catalog.lock.json` (`MCP_CATALOG_LOCK_WRITE=1 npx vitest run test/mcp-catalog.test.ts`; digest only, no effect escalation, the tool stays read only).

Other repo: `trooth-semanto-worker/docs/program/CONTRACT-2026-10-23.md` section 5.

Note for whoever owns trooth-web: the MCP catalog digest changed (new input on `trooth_company_changes`); any copy of the digest outside worker-f follows the lock.

## Reference products

- Signature: Stripe webhook signatures (`Stripe-Signature: t=,v1=`, HMAC-SHA256 over `timestamp.payload`, five-minute default tolerance, several v1 values during a secret roll, constant-time compare); Standard Webhooks (Svix) five-minute tolerance.
- Idempotency: Shopify's "Ignore duplicate webhooks" (dedupe on the event id header), Stripe's guidance to record processed event ids; here a database unique constraint on `event_id`.
- Cursor feed: Stripe's list API (`starting_after` an object id, stable under inserts), applied as a monotonic sequence cursor that never goes null so a poller resumes where it stopped.

Sources: https://docs.stripe.com/webhooks/signature, https://www.svix.com/resources/glossary/timestamp-tolerance/, https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates, https://hookdeck.com/webhooks/guides/implement-webhook-idempotency.md

## Tests and results

New file `test/semanto-recall-events.test.ts`, 30 tests, through the real Worker entry (`src/index.ts` app.fetch) on real SQLite (`test/_tools/sqlite-d1.ts`):
- signature valid, wrong body, wrong secret, missing and malformed header, expired (old and future), rolled secret with two v1 values, missing secret 503 in plain words, internet host 404;
- schema refusals with field paths, optional fields absent or null, 413 cap, 415, per-workspace rate limit, audit row;
- duplicate event 200 `{ duplicate: true }` with the same sequence, unique constraint at the database, AUTOINCREMENT never lowers after a delete, changed recall is a new change;
- ordering and cursor stability across inserts (other workspace's insert in between, earlier page re-read unchanged, empty poll keeps the cursor), read before any event creates nothing, forged cursors refused;
- end to end REST: a DPoP-bound agent key polls `GET /v1/facts/changes`, sees the new recall after its cursor once, the retry and next poll show nothing, another workspace never sees it, the next recall appears alone; limit and has_more;
- end to end MCP: `tools/call trooth_company_changes` through `/public/mcp` with trooth.co stubbed, sees the recall after `recall_cursor` once with its provenance word, another domain's record does not carry it, listed where record history is not kept, forged `recall_cursor` is bad_input;
- migration up equals the Worker's schema and applies twice; down removes table, indexes and marker and the next event recreates it; no trigger, no timer, crons unchanged.

Suite results after the change:
- `npx vitest run`: 118 files passed, 1511 tests passed. (Before the change: 116 files and 1476 tests passed, 4 skipped, and `test/trust-docs-release-rule.test.ts` timed out in its Miniflare `beforeAll` while the typecheck ran beside it. It passes in the full run after the change.)
- `npx tsc --noEmit`: clean.
- `npm run verify`: passed (18 of 18 in the last standalone suite, every earlier one ok).
- `npm run check:secrets`: clean. `node scripts/derive-schema.mjs --check`: current, 1190 static statements compile.
- worker-f has no lint script.
