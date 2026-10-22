# Compiler report

Area: `src/compiler`. Tests: `test/compiler.test.ts`. Fixtures: `test/fixtures/compiler/` (the fictional company Acme Inc at acme.com; every figure in them is made up).

## What was built, file by file

| File | What it does | Practice or standard it follows |
| --- | --- | --- |
| `src/compiler/ports.ts` | The ports: `HttpPort` (one request, redirects never followed by the adapter), `Clock`, `Sleeper`, `Resolver`. `MemoryHttp` is the in-memory site for tests and honors `If-None-Match` and `If-Modified-Since`. `WebFetchHttp` is the adapter for Workers and browsers (`fetch` with `redirect: "manual"` and a capped body read). | Ports and adapters |
| `src/compiler/url.ts` | Registrable domain (a built-in table of common two-label suffixes, since no Public Suffix List can be loaded), the normal page url form (https, lower-case host, no fragment, no query, no default port). | Public Suffix List idea |
| `src/compiler/html.ts` | A tokenizer and tree builder with no dependencies: void elements, raw text elements, implied end tags for p, li, dt, dd, tr, td, th, option, character references, everything closed at end of input. Malformed input never throws. | WHATWG HTML Living Standard, section 13 |
| `src/compiler/fetch.ts` | `Fetcher` behind the port: SSRF guards (not https, literal or resolved loopback, RFC 1918, link-local, carrier-grade NAT, multicast, unspecified, reserved and cloud metadata addresses, local names), redirects followed only on the registrable domain and at most five hops, 2 MB body cap with `truncated` set, conditional GET, a per-host interval, the user agent `TroothSemanto/1.0 (+https://trooth.co/semanto; witness)`, and `source_hash` over the raw bytes. `ChangeDetector`: sitemap lastmod, then conditional GET, then raw hash; an unchanged byte sequence is never reported as a change. | RFC 6890, RFC 9110 sections 13.1 and 15.4 |
| `src/compiler/discover.ts` | The five sources: robots.txt (group by product token, longest-match Allow and Disallow, Sitemap lines), sitemaps and sitemap indexes (lastmod kept, plain-text sitemaps too), the homepage and a breadth-first crawl of internal links (same registrable domain, https, no fragments or query strings, rel=canonical preferred, nofollow skipped, assets skipped), llms.txt links, and the well-known paths. Login, cart, account, admin and personalized paths are listed as excluded with a reason and never fetched; robots-disallowed paths likewise. Cap default 500. Returns the successful fetches so the build does not fetch twice. | RFC 9309, sitemaps.org 0.9, llmstxt.org |
| `src/compiler/extract.ts` | HTML to markdown word for word. Chrome removed by role (nav; header and footer outside article, aside, main, nav, section; script, style, noscript, svg, forms and controls, dialogs, cookie banners by id or class, hidden and aria-hidden elements) and by repetition (`detectChrome`: a block on more than 60 percent of pages, over at least three pages). Headings, paragraphs, nested lists, GFM pipe tables with a caption, links with absolute https hrefs, images as alt text with src, blockquotes, fenced code with language, definition lists. Fixed front matter (title, url, lang, witnessed_at, source_hash, and `part: n of m` when split), LF endings, one trailing newline, byte deterministic. Index signals: noindex and nosnippet from meta robots, googlebot and X-Robots-Tag, canonical, hreflang, robots_blocked. Pages over 2,000,000 bytes split at heading boundaries by whole sections. `sentencesOf` gives the plain sentences used as anchors. | GFM spec 0.29, HTML-AAM implicit roles, Google Search Central robots meta specifications |
| `src/compiler/facts.ts` | Fact candidates from JSON-LD and microdata (Organization and its subtypes, LocalBusiness, Product, Offer, FAQPage, Article and BlogPosting, ContactPoint, PostalAddress, OpeningHoursSpecification) and from text patterns (legal name with a company suffix, US-style postal address, phone numbers, opening hours, support and other emails, founding year, statements with a number). Every fact is `declared` with evidence `{ url, witnessed_at, anchor }`; the anchor is the exact sentence, or the JSON-LD path for structured data. Schema mapping attached where one exists. Placeholders (n/a, unknown, tbd, empty) are never facts; an absent field produces nothing; malformed JSON-LD produces nothing. Ids come from `factId` in core. | W3C JSON-LD 1.1, WHATWG microdata, schema.org |
| `src/compiler/jsonld.ts` | The write-back: Organization (LocalBusiness when hours are declared) with name, legalName, url, logo, sameAs, foundingDate, telephone, email, leiCode from `identity.lei`, PostalAddress, ContactPoint, openingHoursSpecification; WebSite with the Trooth profile as sameAs; Product and Offer from the products tier (`unknown[]`, objects of the documented shape accepted); FAQPage from question_map entries answered on site that carry a fact id; Article from pages with article facts. Site-wide `@graph` and per-page blocks (nodes whose sources sit on that page), the `<script type="application/ld+json">` string with `</` escaped, the `<link rel="alternate" type="text/markdown">` tag, and a parallel trace map `{ jsonld_path: source }` where source is a fact id, or `header:identity.domain`, `header:identity.lei`, `header:profile`, `page:<smp id>` or `product:<product_id>` for the values that live in the header, the manifest or the products tier. | Google Search Central structured data guidelines, schema.org |
| `src/compiler/llms.ts` | llms.txt (H1, blockquote summary, H2 sections by first path segment, one-line descriptions from the first sentence of each page, a Trooth section pointing at `/.well-known/trooth.semanto`, the Network copy, llms-full.txt and sitemap.md), llms-full.txt (every page in manifest order with page separators carrying url and id), sitemap.md (titled links in a path hierarchy). The module comment states that Google has said it does not use these files and that they are for other readers. | llmstxt.org |
| `src/compiler/build.ts` | `buildVersion`: discovery plus fetched pages plus extraction plus facts become a `SemantoFile` in state `read`, with `pages_manifest` (tokens and original_tokens from `estimateTokens`), `pages_root`, `facts_root`, tier hashes, `root_hash`; bodies keyed by page id; the coverage receipt `{ id, found, read, left_out: [{ url, reason }], changed, removed }` with an `smr_` id; the three llms files; per-page index signals. Incremental rebuild: with `previous` and `changed_urls`, unchanged pages keep their entries, bodies, witnessed_at and facts; a page whose source_hash differs is re-rendered even if not listed. Facts are kept once per key and value across the site. | `src/core/semanto.ts` hashing rules, RFC 6962, RFC 8785 |
| `src/compiler/index.ts` | Re-exports the compiler surface. | |

## Requirement numbers covered

- Google-gap items 1, 3, 6.
- Delivery items 1 to 4 and 20.

## Change to src/core

One optional field added to `PageEntry` in `src/core/semanto.ts`, so the manifest can carry the HTML token estimate for the `x-original-tokens` header. No hashing rule or validation changed; existing files stay valid.

```diff
   bytes: number;
   tokens: number;
+  /** Token estimate of the HTML as fetched, for the x-original-tokens header. */
+  original_tokens?: number;
   /** ISO 8601, when Trooth fetched and rendered the page. */
```

## Decisions worth knowing

- Query strings are dropped from page urls. A site that needs `?page=2` to be a separate page is not covered by this version.
- Repetition-based chrome needs at least three rendered pages; on one or two pages only role-based removal applies, so a two-page site is never stripped of real content.
- Pages marked noindex are kept in the pages tier with the signal recorded in `index`; they are public pages the company published. The serve and monitor layers decide what to do with the signal.
- The HTML cap is 2 MB; a page above it is left out with the reason `HTML above the 2 MB cap`. The markdown part limit is 2,000,000 bytes.
- The per-host interval defaults to 500 ms; tests inject a clock and a sleeper so nothing waits.
- `DEFAULT_CONTROLS` in build.ts sets `content_signals` to `{ ai-train: false, search: true, ai-input: true }` when the caller gives none. This is a company setting; the settings layer should pass the company's own.
- The trace map points at a fact id for every value that came from a fact. The handful of values that come from the header or the products tier point at `header:`, `page:` or `product:` names, and the tests check that every traced source resolves.

## Stubbed or needs a founder step

- `WebFetchHttp` is the production adapter and is not exercised by the tests (no network in tests). The Worker should pass `new WebFetchHttp()` plus, where available, a resolver so the guard can check resolved addresses; the Workers runtime does not expose DNS, so in production the literal-address and name-suffix guards apply and the resolver is absent.
- Gzip sitemaps (`sitemap.xml.gz`) are not decompressed.
- Text patterns for addresses cover the US form (street, city, two-letter region, five-digit code). Other countries come through JSON-LD and microdata.
- The question_map and the products tier are inputs to the build; nothing in this area produces them.

## How to run

```
npx vitest run test/compiler.test.ts
npx tsc --noEmit
```

Both pass for the compiler files. `tsc` reports errors in other areas' files at the time of writing; none are in `src/compiler`, `test/compiler.test.ts` or `src/core`.
