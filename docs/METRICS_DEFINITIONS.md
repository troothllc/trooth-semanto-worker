<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- Every number the Semanto product shows and exactly how it is counted. Follows the practice of Mintlify's public data page and Vercel's status page: a named period on every panel, a method next to every count, and "no data" kept apart from "zero". -->

# Metrics definitions

Every number on a Semanto surface (the dashboard panels in `web/semanto/`, the public API, the Trust Profile) is counted the way this file says, from the rows named here, and from nothing else. No number is typed into copy. Where a module is not yet wired, the panel shows the empty state and never a placeholder figure. The file lists, for each number: where it comes from, how it is counted, what it includes and leaves out, and the period.

Three rules apply everywhere:

1. A count is never a judgment. Trooth counts what was said, read, served or compared. It never produces a number or a grade about a company.
2. Zero and no data are different. "No reads recorded yet" means the receipt store has no rows for the period; `0` means rows exist and none match. Panels say which.
3. Every period is UTC and named on the panel.

## Reads and read receipts

Source: `semanto_read_receipts` (`src/readers/receipts.ts`), one row per answered request for a page, the facts file, the llms files, the sitemap or the whole file. The row holds the `smd_` id, `trooth_id`, `version`, `page_id`, `representation`, `agent_key_url`, `keyid`, `proof` (`web_bot_auth` or `none`), `read_at`, and `ip_hash` (a salted daily hash, never an address). A read is recorded when the response status is 200 or 304. Problems (4xx, 5xx) are not reads.

| Number | How it is counted |
| --- | --- |
| Reads (a day) | The sum of `count` over rows with `read_at` in `[day 00:00:00Z, next day 00:00:00Z)` for the company (reads are counted per minute and written once a minute, one row per minute and key, `src/readers/rate-limit.ts`). A HEAD request is not a read. A 304 is a read, because the reader confirmed it holds the bytes. |
| Reads (a period) | The sum of the days in the period. |
| Proved who they were | Rows with `proof = web_bot_auth`. The request carried a Web Bot Auth signature that checked out against the key directory it named (`src/readers/webbotauth.ts`). Nothing else counts as proven; a User-Agent string never does. |
| Unproven reader | Rows with `proof = none`. Shown as one row named "unproven reader", never split by User-Agent. |
| Named agent | A proven row is named by its key directory: the published name when the directory is in the known table (checked against the operator's documentation), otherwise the directory's host name. The name is the directory's, not a claim about the company behind it. |
| Trooth's checks | None today. Trooth's hourly change detection (the `15 * * * *` cron) fetches the company's own origin pages, not the served Semanto copies, so it records no read receipt and is in no count here. Trooth has no Web Bot Auth key directory yet; if it gets one and reads served copies, its reads will be shown in their own column. |
| Pages read | Distinct `page_id` among the rows. |
| By representation | Rows grouped by `representation` (`markdown`, `jsonld`, `json`, `llms`, `sitemap`). |
| Daily digest | `summarize` over the day's rows: `total`, `proven`, `unproven`, `by_agent`, `by_page`, `by_representation`, and the list of receipt ids. The digest is signed by Trooth's witness key (`GET /os/semanto/{trooth_id}/receipts`) and lists the receipt ids it counted, so a count shown later can be checked against them. It is not appended to the public log. |
| CSV | One row per receipt, RFC 4180, the columns above. The `ip_hash` column is the salted hash. |

Not counted anywhere: requests the adapter passed through to the host (HTML), requests answered from a CDN cache without reaching the adapter or the API (the panel says "reads Trooth answered" for this reason), and requests refused by a rate limit.

## Pages, facts and versions

Source: the signed file (`src/core/semanto.ts`) and `semanto_versions`, `semanto_pages`, `semanto_facts`.

| Number | How it is counted |
| --- | --- |
| Pages | `header.pages_manifest.length` of the version. A long page split into parts counts once per part, because each part is its own signed document; the panel says "pages and parts" when any `part` member is present. |
| Facts | `facts.length` of the version. |
| Facts by provenance | Facts grouped by the four words `witnessed`, `public_record`, `attested`, `declared`. Never merged, never weighted. |
| Pages found, read, left out | From the coverage receipt (`smr_`): `found` is every URL discovery produced, `read` is the pages in the manifest, `left_out` is the list with a reason per URL (sign-in, non-200, noindex, owner choice, part limit). `found = read + left_out.length`, and a test checks the parts sum to the total. |
| Version | `header.version`. Shown with its state word (`docs/spec/semanto-file.md`) and `signed_at` in UTC. |
| Changed pages | Pages of the current version whose live `source_hash` differs from the signed one after `signed_at`, from `semanto_change_state` filled by the monitor. |
| Tokens | `tokens` in the manifest and tiers, from `estimateTokens` (`src/core/tokens.ts`): a blend of words times 1.33 and characters over 4. It is an estimate under Cloudflare's header names and is labeled "about" wherever it is shown. It is never presented as a measurement from a specific model. |

## Consistency monitor

Source: `semanto_monitor_runs` and `semanto_alerts` (`src/monitor`). A run compares the signed record with each surface the company connected: the live page, the schema.org data in it, Google Merchant Center, Google Business Profile, the UCP and ACP feeds.

| Number | How it is counted |
| --- | --- |
| Surfaces checked | Surfaces with state `read` in the run. `absent` (not connected) and `failed` (could not be read) are listed by name, not counted as checked. |
| Mismatches | Rows of the run with kind `differs`, `missing_on_surface`, `missing_in_record` or `stale`, one per key per surface. |
| By severity | `trust` (a value Google compares: price, availability, name, address, phone, hours), `visibility` (structured data absent, so the fact cannot be read as data), `note` (everything else). The panel groups in that order. |
| Last run | `finished_at` of the newest run, UTC. |
| Indexable pages | Pages with none of `noindex`, `nosnippet`, `robots_blocked`, `canonical_elsewhere`, `non_200`, `soft_404`; pages `not_fetched` are listed separately, not counted either way. |

A mismatch count compares two surfaces. It never says which one is right; the signed value and the surface value are shown side by side.

## Gap report

Source: the weekly gap report (`src/gap/report.ts`), `smg_` ids. A report asks each configured provider the question set and classifies each answer against the signed record.

| Number | How it is counted |
| --- | --- |
| Providers set up | Providers with a key in the environment at run time. A provider without a key is listed with the reason and has no counts, never zeros. |
| Questions asked | Questions sent to the provider. `errors` is the subset where the request failed; those have no classification. |
| Matches | Findings with classification `matches`: the claim agrees with the signed value and a citation points at the company's domain or the Trooth Network. |
| Says something different | `differs`: the claim disagrees with the signed value. The signed statement is the correction. |
| Left it out | `not_answered`: the answer says nothing about the key. |
| States something you have not published | `unsupported_claim`: the answer states something the record does not cover (no fact, or a fact whose value is `not_published` or `not_read`). |
| Matches, but took it from someone else | `cites_third_party`: the claim agrees but no citation is the company's own domain or the Trooth Network. |
| Corrections | One per `differs` finding: provider, question, what it said, the signed statement, the fact id, the evidence URL. |
| Before and after | The same five counts from the previous report and this one, per provider, and the difference. Shown only when a previous report exists. |
| Citation share | Answers with at least one citation on the company's own domain, over answers with any citation. |

Every count is a count of what an assistant said on one day with one model named in the report. It is not a measurement of the company and not a prediction.

## Keys and binding

Source: `semanto_keys` and the identity module (`src/identity`).

| Number or state | How it is determined |
| --- | --- |
| JWK Set served | The last fetch of `/.well-known/trooth-keys.json` on the domain answered 200 with a set containing the signing key's `kid`. `checked_at` is shown. |
| DNS record | The last DNS-over-HTTPS lookup of `_trooth-keys.<domain>` TXT returned `v=trooth1; kid=<the signing kid>`. |
| LEI match | The record's `legal_name` equals the GLEIF legal name for the LEI after case and whitespace folding, and the GLEIF record is ACTIVE and ISSUED. `null` when no LEI is on the record. |
| Binding level | `none` (no key), `host` (JWK Set only), `domain` (JWK Set and DNS), `domain_and_entity` (both plus LEI match). |

## Log

Source: `semanto_log` and `semanto_tree_heads` (`src/ledger`).

| Number | How it is counted |
| --- | --- |
| Log entry | The leaf index of the version. Shown as is. |
| Tree size | `tree_size` of the tree head the proof was made against. |
| Checkpoint age | Now minus `signed_at` of the newest tree head. An alert when it exceeds 36 hours (the nightly checkpoint plus slack). |

## Delivery

Source: `semanto_host_detection` and the settings (`src/serve/detect.ts`, `src/settings/delivery.ts`).

| State | How it is determined |
| --- | --- |
| Host | The classification from response headers and body on the last detection, confirmed by the company in settings. |
| Well-known served | `GET https://<domain>/.well-known/trooth.semanto` answered 200 with the company's current `root_hash`. |
| DNS pointer | `_trooth.<domain>` TXT present. |
| Same bytes | The own-domain answer and the Trooth-hosted answer for the same path and `Accept` have equal `Content-Digest`. Checked hourly as part of the monitor; a difference is a `trust` mismatch on the `live_page` surface. |

## Funnel events (product analytics)

Server-side events, one row each, never computed on the client: `semanto.preview_viewed`, `semanto.build_started`, `semanto.read_notice_sent`, `semanto.confirmed`, `semanto.signed`, `semanto.served_first_time`, `semanto.first_proven_read`, `semanto.settings_saved`. A step's count is distinct companies with at least one event of that kind in the period. Conversion between two steps is the second count over the first, two decimals, with both counts shown beside it. (To confirm at review: the event writer lives with the dashboard API, outside this repository.)

## What is never shown

A number or grade that judges the company, a rank, a percentage of "truth", a prediction that AI will prefer or trust the company, a comparison that ranks companies, or a figure Trooth did not measure. Fixture numbers appear only in files named as fixtures and never on a product surface.
