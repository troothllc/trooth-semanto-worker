# Monitor report: surface consistency, indexability, write-back, alerts

Folder: `src/monitor`. Tests: `test/monitor.test.ts` with fixtures under `test/fixtures/monitor/` (Acme Inc, acme.com; no figure in them is a measurement).

## Why it exists

Google's AI features guide (updated 15 June 2026) says its AI answers come from the normal index, that it reads no llms.txt or AI-specific file, that a page must be indexed and snippet-eligible, that structured data, Merchant Center and Business Profile help, and (in the UCP guidance) that a mismatch between Merchant Center data and the website lowers trust. The monitor measures inconsistency and staleness across every surface Google reads, compared with the signed Semanto record, and writes the signed truth back to each surface. It reports what each surface says and what differs. It never judges the company.

## What was built, file by file

| File | What it does |
| --- | --- |
| `src/monitor/types.ts` | The shared shapes: `Surface`, `SurfaceFact`, `SurfaceRead`, `LivePageRead`, the local `Product` and `Offer` shapes for feed comparison, `SignedRecord`, `Mismatch` (kind and severity), `SurfaceStatus`, `PageIndexability`, `IndexabilityReport`, `MonitorRun` and its row shape (semanto_monitor_runs), `Alert` and its row shape (semanto_alerts). |
| `src/monitor/ports.ts` | Ports with in-memory forms: `FetchPort` (readers only GET; write-back sends through `send`), `ClockPort`, `StorePort` (runs, open alerts, sent count since an instant, mark sent, resolve), `EmailPort` (Resend POST /emails shape), `TokenPort` (the customer's OAuth token per Google connector). `fetchFromMap`, `memoryStore`, `memoryEmail`, `memoryTokens`, `fixedClock`, `globalFetchPort`. |
| `src/monitor/normalize.ts` | Tolerant comparisons: phones to E.164 (ten digits read as the default country), addresses to one spacing and USPS short forms, prices to amount plus ISO 4217 code from strings, numbers or objects, availability to the schema.org names, hours to sorted `HH:MM-HH:MM` spans per day or `closed`, names to letters and digits, GTINs without leading zeros, urls without trailing slash or fragment. `familyOf(key)` picks the comparator, `equivalent()` applies it, `whatDiffers()` names the words that differ, `displayValue()` prints a value for a person. |
| `src/monitor/html.ts` | A dependency-free HTML reader: JSON-LD blocks and their nodes and @ids, microdata items with nested properties (WHATWG HTML microdata), title, robots meta (robots and googlebot), canonical link, visible text, entity decoding. |
| `src/monitor/surfaces.ts` | The readers. (a) `readLivePage` / `readLivePageFrom`: page text, JSON-LD and microdata facts for Organization and LocalBusiness types (name, phone, address, website, hours) and Product types (name, price, availability, gtin, url, brand), index signals including X-Robots-Tag, the generated @ids, the HTML digest for change detection. (b) `signedFacts` / `readSemanto`: the record flattened to the same keys, with a fresh signed offer winning over the product's own price and availability. (c) Merchant Center: `parseMerchantCenterContentApi` (v2.1 products.list shape), `parseMerchantCenterTsv`, `parseMerchantCenterXml` (RSS 2.0 with the g: namespace), each reading id, title, link, price, availability, gtin, brand, consumer_notice; `readMerchantCenter` detects the format. (d) `parseBusinessProfile` / `readBusinessProfile`: Business Information API v1 Location (title, phoneNumbers.primaryPhone, storefrontAddress, regularHours.periods, websiteUri, categories). (e) `parseUcpManifest` (version, services, capabilities, endpoints), `parseUcpCatalogItem` / `ucpCatalogRead` (id, merchant_item_id, native_commerce, title, link, price, availability, gtin, brand, consumer_notice), `readUcp`. (f) `parseAcpFeed` (JSON lines or a JSON array, OpenAI Agentic Commerce product feed fields including inventory_quantity), `readAcp`. All facts come out under `identity.legal_name`, `contact.phone`, `contact.address`, `contact.website`, `hours.<day>`, `product.<sku>.price` and the other product keys. |
| `src/monitor/consistency.ts` | `compareSurface` (feeds and listings), `productsMissingOnSurface`, `compareLivePage` (structured values compared; a fact whose evidence is this page and which the page's data lacks is searched for in the visible text; no JSON-LD at all is one `page.jsonld` visibility mismatch; a page whose bytes changed since signing is one `page.content` note with both dates), `compareAll`, `surfaceCovers` (which keys a surface has a field for, so a missing value is only reported where the surface could carry it), `severityFor` (trust for price, availability, name, address, phone, hours; visibility for absent structured data; note otherwise), `sortMismatches` (trust first), `buildRun` (id `smm_`, content-addressed), `runToRow` / `runFromRow` for semanto_monitor_runs. The stale kind applies when the surface's observed instant is earlier than the signed value's witnessed_at and the values differ. |
| `src/monitor/indexability.ts` | `pageIndexability` and `indexabilityReport`: per signed page, eligible or not with reasons (`noindex`, `nosnippet`, `robots_blocked`, `canonical_elsewhere`, `non_200`, `soft_404`, `not_fetched`) from the PageEntry index signals plus the live read, and `jsonld_present` by the generated @id (default `<url>#semanto`; pass `generatedId` to match the compiler). `robotsAllows` is an RFC 9309 matcher (longest rule wins, allow wins ties, googlebot group before `*`). Site totals by reason. The header comment states that eligibility is Google's rule (indexed plus snippet-eligible) and that indexing is never guaranteed. |
| `src/monitor/writeback.ts` | Connectors that build payloads from the signed record: `merchantCenterPayload` (Content API v2.1 products.insert bodies with price, availability, gtin, brand, `consumerNotices`, and the UCP attributes `native_commerce` and `merchant_item_id` as custom attributes), `merchantCenterSupplementalFeed` (TSV), `businessProfilePayload` (locations.patch with an `updateMask` over title, phoneNumbers.primaryPhone, storefrontAddress, websiteUri, regularHours; `splitAddress` turns the one-line signed address into the structured form, overridable), `jsonLdDiff` / `siteJsonLdPayload` (the page's current JSON-LD versus the generated block, by @id, path by path), `acpFeedPayload` (JSON lines), `ucpCatalogPayload` (catalog JSON with merchant_item_id, native_commerce, consumer_notice). `allPayloads` builds every one from the same record and names what it skipped. `sendPayload` sends an HTTP payload only with the customer's token from the token port; files are returned for upload. |
| `src/monitor/alerts.ts` | Plain-language alerts: `messageForMismatch`, `messagesForIndexability`, `alertsFrom` (id `sma_`, content-addressed on company, kind and key), `dedupeAlerts` (same kind and key against open alerts), `resolvedAlerts` (open alerts that no longer appear), `applyDailyCap` (default 5 per company per day, trust first), `buildEmail` / `sendAlertEmail` (plain text and a minimal HTML in Ink #202124 and Paper #F7F8F8 with blue #1A73E8 on the one action link), `toDashboard` (the list shape), `alertToRow` / `alertFromRow` for semanto_alerts. |
| `src/monitor/run.ts` | `runMonitor`: reads the record as a surface, reads each connected surface (absent ones are listed as absent with the reason and never compared; failed reads are listed as failed), reads the signed pages live (capped by `maxPages`), fetches robots.txt, compares, checks indexability, stores the run, dedupes and caps alerts, emails when an email target and port are given, and returns a summary with counts by severity, surface statuses, page totals, alert counts, and `fixes` in order of effect (trust, then visibility, then notes). The customer's token is only ever sent to Google's own API hosts. |
| `src/monitor/index.ts` | The barrel. |

### Change outside the folder

`src/core/ids.ts`: two prefixes added to the registry (the brief allows a small export when reported). Exact diff:

```
-//   smg_  a gap report                digest of the canonical report body
+//   smg_  a gap report                digest of the canonical report body
+//   smm_  a monitor run               digest of the run
+//   sma_  an alert                    digest of company, kind and key
-export type IdPrefix = "smv" | "smr" | "smp" | "smf" | "smo" | "smk" | "sms" | "smn" | "smt" | "smd" | "smb" | "smg";
+export type IdPrefix = "smv" | "smr" | "smp" | "smf" | "smo" | "smk" | "sms" | "smn" | "smt" | "smd" | "smb" | "smg" | "smm" | "sma";
-  const m = /^(smv|smr|smp|smf|smo|smk|sms|smn|smt|smd|smb|smg)_[a-z2-7]{26}$/.exec(value);
+  const m = /^(smv|smr|smp|smf|smo|smk|sms|smn|smt|smd|smb|smg|smm|sma)_[a-z2-7]{26}$/.exec(value);
```

(The `smg` entry was added by the gap module at the same time; the monitor's lines sit next to it.)

## Requirement numbers covered

Google-gap items 2 (consistency across Merchant Center, Business Profile and the site), 3 (indexed and snippet-eligible pages, structured data present), 4 (write-back of the signed truth to every surface) and 31 (plain-language alerts and the monitor run).

## Mismatch kinds and severities

| Kind | Meaning |
| --- | --- |
| `differs` | Both sides have a value and the tolerant comparison says they differ. `detail` names what differs. |
| `missing_on_surface` | The record has the value, the surface has a field for it and does not carry it. For a product: the surface does not list the product at all (reported once). On a live page: the page's data and text no longer show the value. |
| `missing_in_record` | The surface has a value or a product the record lacks. Always a note. |
| `stale` | The surface's observed instant is earlier than the signed value's witnessed_at and the values differ. |

Severity: `trust` for phone, address, name, hours, product price, availability and name; `visibility` for the `page.jsonld` key (no structured data on a page); `note` otherwise.

## Stubbed or needing a founder step

- Google OAuth: the Merchant Center Content API and Business Profile reads and writes need the customer's OAuth token through `TokenPort`. The OAuth consent flow, token storage and refresh are not in this folder (they belong with the workspace settings). Without a token, feeds are still read from public feed URLs and every payload is still built for the dashboard; nothing is sent.
- Google Cloud project: a project with the Content API for Shopping and the Business Profile APIs enabled, and the OAuth client, is a founder step.
- Resend: `RESEND_API_KEY` and `ALERT_FROM` in the environment; the Worker binds `globalFetchPort` and a Resend-backed `EmailPort` at integration. The port shape here matches POST https://api.resend.com/emails.
- D1: a `StorePort` over `src/db` for semanto_monitor_runs and semanto_alerts; the row shapes (`runToRow`, `alertToRow`) are ready. `alert.key` and `alert.severity` travel inside `detail_json` because the table has no columns for them.
- The route `POST /os/semanto/{trooth_id}/monitor/run` lives in `src/index.ts` and calls `runMonitor`.
- The generated JSON-LD @id comes from the compiler's jsonld module; pass `indexability.generatedId` if its id form is not `<url>#semanto`.
- UCP catalog item field names are read tolerantly (id or sku, title or name, link or url, price as string or object) because the catalog file shape may still move; the manifest shape follows ucp.dev as published in January 2026.
- Feed reads are full reads; a cap on feed size for very large catalogs is not in place.

## How to run

```
npx vitest run test/monitor.test.ts
npx tsc --noEmit
```

36 tests. They cover: every reader against its fixture; mismatches of every kind and severity for a fixture where the Merchant Center price differs, the Business Profile phone differs, the live Pricing page has no JSON-LD and is noindex, the kettle has a consumer notice in the record but not in the feed, a feed product is missing from the record, and the Security page changed since it was signed; tolerant comparisons that do not flag equivalent phone formats, address spacing, GTIN leading zeros or a fresh offer price; write-back payloads carrying the signed values and the updateMask, one change in the record changing every payload, and sending only with a token; alerts that read plainly, dedupe, resolve and respect the cap; the runner listing an absent surface as absent and a failed read as failed, never as a mismatch.
