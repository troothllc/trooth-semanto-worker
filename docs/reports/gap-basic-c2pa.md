# Report: gap report, Semanto Basic, first-publication proof, signed Content Signals, C2PA bridge

Date: 2026-10-22. Folders: `src/gap`, `src/basic`, `src/c2pa`, `test/gap.test.ts`, `test/basic.test.ts`, `test/c2pa.test.ts`, `test/fixtures/gap`. Imports only from `src/core`. No dependency added.

## What was built, file by file

### A. The gap report (`src/gap`)

| File | What it does |
| --- | --- |
| `src/gap/ports.ts` | The ports: a WHATWG-shaped `FetchPort`, the `SerpPort` (Google AI Mode, Google AI Overviews, Microsoft Copilot come only through it; no scraping of Google or Bing in this code), `ProviderKeys` (the shape `Env` satisfies), a clock. |
| `src/gap/prompts.ts` | Four buyer question sets parameterized by company, domain, products, competitor and a named service: B2B (18), shopping (15 per product), local (15), competitor (16). 64 questions for one company with one product. Every question maps to dotted fact keys. `KEY_CATALOG` says how each key is read (money, boolean, hours, phone, address, percent, days, named, list, text) and the words that mark its topic. `questionsFor`, `allQuestions`, `coveredKeys`, `productSlug`. |
| `src/gap/providers.ts` | One interface `ask(question, options)` returning `{ provider, model, answer_text, citations, asked_at, raw }`. Pure request builders and response parsers for OpenAI (Chat Completions with `web_search_options`, `url_citation` annotations), Anthropic (Messages with `web_search_20250305`, `web_search_result_location` citations), Gemini (`generateContent` with `google_search`, `groundingChunks`), Perplexity (`sonar`, `search_results`). SERP adapters for the three surfaces over the port. `MODELS` and `ENDPOINTS` are string constants in one place. A provider without a key, or a surface without a SERP provider, returns `{ configured: false, reason }` and is listed in the report as "not configured". A non-2xx answer is a `ProviderError`, not an answer. `allAdapters(keys, fetch, serp)` returns all seven. |
| `src/gap/compare.ts` | Extractors (money with currency, booleans with negation, hours normalized to 24h, phone digits, street addresses with abbreviations expanded, percentages, day counts, named sentences). `compareAnswer(question, answer, ctx)` classifies each key as `matches`, `differs`, `not_answered`, `unsupported_claim` (no fact, or a fact whose value is `not_published` or `not_read`) or `cites_third_party` (agrees, but no citation is the company's domain or the Trooth Network). Every finding carries the signed statement, fact id, evidence url, provenance and a citation note (`own_domain`, `trooth_network`, `neither`, `none`). |
| `src/gap/report.ts` | `buildGapReport` produces `{ object: "semanto.gap_report", id (smg_), trooth_id, kind, ran_at, providers, findings, totals, corrections, own_domain_citation_share }`; `runGapReport` asks every adapter every question with a small concurrency limit. `renderGapReportMarkdown` is the human reading. `WEEKLY_RUN` (`0 9 * * 1`, UTC, wrangler snippet), `weeklyRunPlan`, `nextMondayNine`. `diffReports` and `renderDiffMarkdown` give the before-and-after by classification with `resolved` and `regressed` lists. Counts and shares only. |
| `src/gap/competitor.ts` | The free small-business view: a company and up to three competitors, the local or shopping set against each (`runCompetitorQuestions`), folded into rows per question (`buildCompetitorView`): which companies were named, what was said, whether the company's own site was cited. `renderCompetitorMarkdown` and `renderCompetitorHtml` (mobile-first, Ink on Paper, one action link in #1A73E8). |

### B. Semanto Basic (`src/basic/tier.ts`, `src/basic/ports.ts`)

State machine `claim -> domain_proved -> basic_built -> upgraded`. Domain proof by DNS TXT at `_trooth.<domain>` with value `v=trooth1; claim=<token>` or by `https://<domain>/.well-known/trooth-claim.txt` holding the token, through `DomainProofPort`. `buildBasic` refuses in state `claim` with plain words; the record is built through `RecordBuilderPort` (the compiler) in state `read`. `upgrade` needs a published Trust Profile with a signing key. `basicResponse` wraps every Basic body with `witnessed_by: "Trooth"`, `signed_by_company: false`, `record_state: "read"` and the fixed notice "This record is witnessed by Trooth and not signed by the company"; `basicHeaders` adds `Trooth-Record-State`, `Trooth-Witnessed-By`, `Trooth-Signed-By-Company` (no `X-` names). `BASIC_ENTITLEMENTS` lists what Basic serves (hosted copy, head-tag mode, competitor report, alerts) and does not (the company signature, own-domain serving, commerce). `SETUP_CHECKLIST` has six steps with targets summing to 600 seconds; `measureSetup(started, completed_at)` reports seconds spent per step and in total from timestamps, with `within_ten_minutes` null until every step has a timestamp.

### C. First-publication proof (`src/basic/first-publication.ts`)

`createFirstPublication` hashes the extracted markdown, builds `{ object: "semanto.first_publication", id (smb_), url, content_hash, title, author?, witnessed_at, trooth_id }`, signs it as a compact JWS with `typ` `JWS_TYPES.firstPublication`, defines the leaf `{ kind: "first_publication", trooth_id, ref, hash, at }`, computes its RFC 6962 leaf hash and appends through `LogPort`. `verifyFirstPublication` checks the id, the signature, the payload and recomputes the hash from the markdown given; changed text returns `content_changed`. `exportDisputeStatement` is the plain-words statement ("Trooth witnessed this text at this address on this date; the record is in a public log at index N").

### D. Signed Content Signals (`src/basic/content-signals.ts`)

From the one policy in `controls.content_signals`: `toHeaderValue` (`search=yes, ai-input=yes, ai-train=no`), `toRobotsLines`, parsers for robots.txt and headers, `checkContentSignalsDrift` (per surface: present, found, which signals differ, plain words), `signContentSignals` (JWS `typ` content-signals with `nbf`) and `verifyContentSignals`.

### E. C2PA bridge (`src/c2pa/bridge.ts`)

`buildC2paManifest` and `buildC2paManifests` produce c2pa-rs manifest definition JSON per media item in the documents tier: `claim_generator`, `claim_generator_info`, `title`, `format`, `instance_id`, and assertions `c2pa.actions` (action `c2pa.published`), `stds.schema-org.CreativeWork` (publisher Organization, Trooth as contributor with `roleName: "witness"`), `c2pa.hash.data` (placeholder the signing tool fills) and the custom `co.trooth.semanto` with `{ trooth_id, version_id, page_id, page_hash, proof_url, url, witnessed_at }`. Text items are skipped with a reason. `textAnnexStatus()` returns the exact string: "C2PA 2.4 Annex A.8 (text) is under review and is not used for text. Pages are covered by the signed Semanto record and its page hashes." `c2patoolCommand` gives the runbook line.

### Change to `src/core` (the one small export)

`src/core/ids.ts`: added the `smg_` prefix (a gap report, digest of the canonical report body) to the registry comment, the `IdPrefix` union and the `isSemantoId` pattern. Exact diff:

```
-//   smb_  a first-publication record
+//   smb_  a first-publication record
+//   smg_  a gap report                digest of the canonical report body
-export type IdPrefix = "smv" | "smr" | "smp" | "smf" | "smo" | "smk" | "sms" | "smn" | "smt" | "smd" | "smb";
+export type IdPrefix = "smv" | "smr" | "smp" | "smf" | "smo" | "smk" | "sms" | "smn" | "smt" | "smd" | "smb" | "smg";
-  const m = /^(smv|smr|smp|smf|smo|smk|sms|smn|smt|smd|smb)_[a-z2-7]{26}$/.exec(value);
+  const m = /^(smv|smr|smp|smf|smo|smk|sms|smn|smt|smd|smb|smg)_[a-z2-7]{26}$/.exec(value);
```

Another agent added `smm_` and `sma_` lines to the same registry comment during this work; those are theirs.

## Requirement numbers covered

- Google-gap item 5: Google AI Mode and AI Overviews are providers in the report, through the SERP port, and Gemini through its API with Google Search grounding.
- 25: the gap report (question sets, providers, line-by-line comparison, corrections with the signed source, weekly run, before-and-after).
- 27: the free competitor report for small businesses.
- 29: Semanto Basic, domain proof only, witnessed-not-signed in every response.
- 30: the local question set (hours, address, phone, services, parking, accessibility, appointment policy and more).
- 32: first-publication proof signed and logged, with the dispute export.
- 33: signed Content Signals with header, robots.txt and drift detection.
- 16: the C2PA bridge for images and PDFs, text annex status stated.
- The gap report from the earlier execution plan (the paid hook and the free competitor report).

## Stubbed, or needs a founder step

1. Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` as Worker secrets. Until set, each provider is listed as "not configured" in every report.
2. SERP data provider: Google AI Mode, Google AI Overviews and Microsoft Copilot come only through `SerpPort`. The founder picks a licensed SERP data provider and writes the one adapter that implements `fetchAnswer(engine, query)`. Nothing in this repository scrapes Google or Bing.
3. Model names: `MODELS` in `src/gap/providers.ts` are the October 2026 names; update there when a vendor retires one.
4. Weekly cron: paste `WEEKLY_RUN.wranglerSnippet` into `wrangler.toml` (owned by the coordinator) and call `runGapReport` from the scheduled handler in `src/index.ts`; persist with `semanto_gap_reports` (`report_json` is the whole object, `id` the smg_ id).
5. The record builder for Basic is `RecordBuilderPort`; the compiler agent's build function is plugged in at integration. The log for first publication is `LogPort`; the ledger agent's append is plugged in. The documents tier and `publicApiBase` for the C2PA bridge come from the served Semanto file.
6. C2PA signing: this module writes manifest definitions only. Signing and embedding need `c2patool` or the c2pa SDK plus a signing certificate the founder installs outside the Worker; `c2patoolCommand` prints the line.
7. Extractors are simple by design (one sentence, one value). A list fact counts as matching when any signed item is named. The signed statement is always printed beside the claim so a person sees both. Tune `KEY_CATALOG` terms as real answers come in.
8. DNS for domain proof: the Worker side needs a DNS-over-HTTPS lookup behind `DomainProofPort.dnsTxt` (for example Cloudflare's resolver at `https://cloudflare-dns.com/dns-query` with `accept: application/dns-json`); the port is written, the HTTPS call is not.

## How to run the tests

```
npx vitest run test/gap.test.ts test/basic.test.ts test/c2pa.test.ts
npx tsc --noEmit
```

49 tests pass. `tsc` is clean for `src/gap`, `src/basic`, `src/c2pa` and the three test files (also with `--noUnusedLocals`); at the time of writing `test/serve.test.ts`, owned by another agent, has type errors that are not from these folders.

Fixtures are in `test/fixtures/gap` (Acme Inc, acme.com, fictional; provider response files mirror the documented API shapes and test the parsers only).
