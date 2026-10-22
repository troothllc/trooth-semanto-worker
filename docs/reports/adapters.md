# Report: host adapters (`adapters/`)

Area: delivery items 11 to 17, 26 and 28. Folders: `adapters/`, `test/adapters.test.ts`, `test/fixtures/adapters/`, this report. No file outside them was touched; `src/core` is unchanged.

## What the adapters do

On the customer's own domain, answer a request for a signed page in markdown or JSON-LD, or for `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json`, `/llms.txt`, `/llms-full.txt` or `/sitemap.md`, by fetching the bytes from the Trooth-hosted copy (or a local cache) and returning them byte for byte with the headers the API sent; otherwise pass the request to the host untouched (HTML answers gain `Trooth-Semanto-Version` and `Link`). The decision is made on the Accept header and the path suffix only. No file under `adapters/` reads User-Agent; the test asserts the decision function's source does not contain the string and that two requests differing only in User-Agent return identical bytes and headers.

Three settings everywhere: `TROOTH_ID`, `TROOTH_API_BASE`, `MODE` (`semanto_only`, `semanto_then_cloudflare_for_unsigned`, `proof_only`).

## Files

### `adapters/shared/` (item 28)

- `semanto-adapter.mjs`: plain JavaScript, no dependencies. `decide(path, accept, manifest, config)` returns `{ serve: true, url, kind }` or `{ serve: false, reason }`; `copyHeaders(response)` copies exactly the thirteen headers (`Content-Type`, `ETag`, `Vary`, `Content-Digest`, `Signature-Input`, `Signature`, `Trooth-Contract`, `Trooth-Semanto-Version`, `Trooth-Page-Hash`, `Link`, `Content-Signal`, `x-markdown-tokens`, `x-original-tokens`); `createManifestCache` fetches the manifest once and keeps it with its ETag behind a `store` interface (memory by default; the Worker wraps the Cache API), revalidating with `If-None-Match` after the ttl and keeping the old copy when the API is unreachable; `handleRequest` is the whole adapter for any host with a Fetch API; `proofHeaders` and `withProofHeaders` add the two headers to HTML. Negotiation is a line-for-line port of `src/core/negotiate.ts` with markdown offered first so `text/*` gives markdown (Cloudflare's documented outcome); the test cross-checks every Accept case and every suffix against the core functions.
- `semanto-adapter.d.mts`: types for the TypeScript adapters and the tests.
- `sign-request.mjs`: RFC 9421 request signatures with RFC 9530 Content-Digest, Ed25519 through WebCrypto, for the commerce connectors (`generateConnectorKey`, `signPost`, `postSigned`, tag `trooth-connector`, components `@method @target-uri content-digest content-type`). Checked in the test with `src/core/httpsig.verifyMessage`.
- `sign-request.d.mts`: its types.

### `adapters/cloudflare-worker/` (item 11)

`src/index.ts` (Worker on a zone route, manifest store on the Cache API, origin via `fetch(request)`), `wrangler.toml` (route pattern, the three vars), `package.json`, `README.md` with the Deploy to Cloudflare button and the `wrangler deploy` path.

### `adapters/vercel/` (item 12)

`middleware.ts` (decides, rewrites served requests to `/semanto/<path>`, adds the headers to HTML; matcher excludes `/.well-known/`), `lib-semanto.ts` (config and one manifest cache per instance), `app/semanto/[[...path]]/route.ts` (fetches and returns the bytes with the API's headers; the folder name is Next.js's catch-all convention), `scripts/semanto-sync.mjs` (build step: downloads the two well-known files into `public/.well-known/` and writes the headers the API sent into `vercel.json`, so the static copies keep their proof), `vercel.json` (build command and headers), `README.md` with the W5 expectation: Vercel's reservation of `/.well-known` is documented for rewrites and redirects, so a static file is expected to serve; the test command and the fallback (Network copy plus DNS pointer plus `Link` header) are written down. A Vercel Deploy Hook pasted into the Trooth dashboard rebuilds on publish.

### `adapters/netlify/` (item 13)

`netlify/edge-functions/semanto.ts` (full adapter with `context.next()` pass-through, `onError: bypass`), `netlify.toml` (the declaration), `_redirects` (the two `200!` lines for the well-known files as the no-code fallback), `README.md`.

### `adapters/fastly-compute/` (item 14)

`src/index.js` (fetch-backend pattern: `trooth_api` and `origin` backends, optional Config Store `trooth_semanto`), `fastly.toml` with a `[setup]` block so `fastly compute publish` asks for the backends and settings once, `package.json`, `README.md`.

### `adapters/akamai-edgeworkers/` (item 15)

`main.js` (`onClientRequest` reads the manifest with `httpRequest`, decides, and uses `request.route()` to a `trooth_api` conditional origin so bodies stream at any size; `onClientResponse` adds the headers to HTML), `bundle.json`, `build.sh` (copies the shared module into the tarball), `README.md` with the property settings (conditional origin, four PMUSER variables).

### `adapters/gcore-fastedge/` (item 16)

`src/index.js` (JavaScript variant for the FastEdge JS SDK; Rust is the native target and is named as such), `package.json`, `README.md` with the two CDN rule choices (all requests, or a path regular expression for suffix-only coverage).

### `adapters/nginx/` (item 17)

`semanto-maps.conf` (maps on `$http_accept` and `$uri` into `$semanto_rep`, plus a `$sent_http_content_type` map for the Link header), `semanto-proxy.conf` (upstream host, request headers passed, `proxy_pass_header` for every Trooth header, cookies and banners hidden), `semanto-server.conf` (the well-known and llms locations, `location /` with `if ($semanto_rep)` proxying to `/by-path$uri` or `/facts.jsonld`), `README.md`.

### `adapters/apache/` (item 17)

`semanto.conf` (`RewriteCond %{HTTP:Accept}` with the same two regular expressions, `[P]` proxying, `RequestHeader unset User-Agent env=SEMANTO`, `Header always set Link` on HTML), `README.md` including the `.htaccess` variant.

### `adapters/wordpress-plugin/` (item 26)

`trooth-semanto/trooth-semanto.php` plus `includes/` (negotiate, client, serve, head, signer, woocommerce, settings), `uninstall.php`, `readme.txt` (WordPress.org format), `README.md`. Plain PHP 8.1, no Composer. Settings page (Trooth ID, mode, API address, connection check, public key, buttons). `template_redirect` at priority 0 negotiates on Accept and suffix, fetches with `wp_remote_get`, caches in transients keyed by URL with the ETag and revalidates with `If-None-Match`, prints the bytes with the API's headers, serves the well-known and llms files, keeps the canonical redirect off `.md` paths. `wp_head` prints `<link rel="alternate" type="text/markdown">`, `<link rel="https://trooth.co/rel/semanto">` and the JSON-LD block fetched from `facts.jsonld`. WooCommerce: product and variation hooks debounced through WP-Cron build a catalog document (sku, gtin from `_global_unique_id`, price, regular and sale price, stock status and quantity, per variation with attributes) and POST it signed (sodium Ed25519, RFC 9421 with Content-Digest; the PHP signature was checked against `src/core/httpsig.verifyMessage` during this work) to `POST {TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog`. The endpoint and document are documented in the README; the API side is built elsewhere.

### `adapters/head-tag/` (item 26, no-code hosts)

`README.md` with the exact one-line tags for Webflow, Squarespace, Wix and Shopify (`rel="alternate" type="text/markdown"`, `rel="https://trooth.co/rel/semanto"`, the JSON-LD script pointer with the note that Google reads JSON-LD only inline), the Webflow Enterprise well-known upload note (under 100 KB), and the Shopify `llms.txt` and `agents.md` theme templates in `shopify/templates/` with the pointer lines (allowed since 28 May 2026).

### `adapters/commerce-platforms/` (item 26, data hooks)

`connector-common.mjs` (key file, document shape, signed send), `shopify/shopify-sync.mjs` (Admin GraphQL query exported as `PRODUCTS_QUERY`, cursor pagination, variant mapping, signed POST), `bigcommerce/bigcommerce-sync.mjs` (Catalog API v3 with `include=variants`), `salesforce-commerce/sfcc-sync.mjs` (OCAPI Shop API `product_search` and `products/{id}`), `woocommerce/README.md` (points at the plugin), `README.md` with install notes and scopes. The Shopify script was dry-run against a fake Admin API during this work; the other two were syntax-checked only.

### `adapters/README.md`

The decision table, the header list, the three settings, the host table from the launch blueprint (Vercel reserves `/.well-known`; Shopify allows no custom root paths; Webflow Enterprise only for well-known files; Wix and Squarespace have no root directory; which adapter or fallback applies to each), the folder list and the API routes the adapters call.

### Tests

`test/adapters.test.ts` (46 tests) and `test/fixtures/adapters/fixture-manifest.json` (a fictional Acme Inc manifest; every figure is made up). Covered: every Accept outcome (14 cases, cross-checked with `src/core/negotiate`), every suffix (cross-checked with `representationFromPath`), the five files whatever the Accept header, each mode including the no-manifest case, the never-by-user-agent rule, `copyHeaders` exactness (drops `Set-Cookie`, `Server`, `CF-Ray`, `Cache-Control`), the manifest cache (once, then `If-None-Match`, 304 keeps, new ETag replaces, unreachable keeps the old, concurrent first fetches deduped), `handleRequest` end to end with a fake API (bytes and headers identical, 304 pass-through, HTML gets the proof headers, 404 passes unchanged, Cloudflare mode falls through, facts for `application/ld+json`), and the connector signature checked with `src/core/httpsig`.

## Requirement numbers

Delivery items 11 (Cloudflare Worker), 12 (Vercel), 13 (Netlify), 14 (Fastly), 15 (Akamai), 16 (Gcore), 17 (nginx and Apache), 26 (WordPress plugin, head tags, commerce platforms), 28 (shared module and its tests). House rules met: no User-Agent switch (rule 3), headers from rule 10 and no `X-Semanto-*`, RFC 9457 problem from the plugin when the API is unreachable (rule 9), SPDX headers on every source file (rule 12; `bundle.json`, `vercel.json`, `package.json` and the fixture cannot carry comments), plain words in every string a person reads (rule 11), fixtures named as fixtures (rule 4).

## Decisions another team must confirm

1. **API routes assumed.** The adapters call, under `{API}/public/semanto/{trooth_id}`: the root (the Semanto file doubles as the manifest through `header.pages_manifest`), `/keys.json` (served as `/.well-known/trooth-keys.json`), `/facts.jsonld`, `/llms.txt`, `/llms-full.txt`, `/sitemap.md`, `/pages/{smp_id}`, and **`/by-path{path}`**, a route not in the ARCHITECTURE.md list: the page by its path on the customer's domain (suffix included, Accept passed through), resolved by the API through the current manifest. nginx and Apache cannot read the manifest and need it; the code adapters use it in `semanto_only` for a page the cached manifest does not list. The serve team should add it (an alias that looks the path up in `pages_manifest` and serves the page or the markdown problem). All paths sit in one table, `API_PATHS` in `semanto-adapter.mjs`, mirrored in the nginx, Apache and PHP files; a rename is a one-line change in each.
2. **Commerce endpoint.** `POST {API}/os/semanto/{trooth_id}/commerce/catalog`, signed with `tag="trooth-connector"` and the covered components above, key id an RFC 7638 thumbprint of a connector JWK the owner pastes into the dashboard. The commerce team builds the receiver; the document shape is in the plugin README.
3. **Tie-breaking in the proxies.** nginx and Apache give HTML on an exact tie such as `text/html, text/markdown`; the code adapters give markdown (server preference). Browsers never send the tie. Written in the READMEs.
4. **Proof headers in every mode.** The brief names them for `proof_only`; the code adapters add `Trooth-Semanto-Version` and `Link` to the host's HTML in all three modes, since agents find the file through them. Say so if that should be `proof_only` only; it is one condition in `handleRequest`.

## Stubbed or needs a founder step

- **Deploy to Cloudflare button**: points at `github.com/trooth-llc/semanto-adapters/tree/main/cloudflare-worker`, the public adapters repository to publish on launch day (this repository is private). Until then the README gives the `wrangler deploy` path.
- **Vercel W5**: the static well-known file needs a real Vercel project to confirm; expectation and fallback are in the README. A Deploy Hook URL field is needed in the dashboard (Delivery) so Trooth can rebuild on publish.
- **Gcore pass-through**: whether a FastEdge app bound to a CDN rule can hand a request back to the CDN, or must fetch the origin itself (as written, with `ORIGIN_HOST`), needs a real Gcore account to confirm.
- **Akamai**: the `trooth_api` conditional origin and the PMUSER variables are property configuration the customer (or Trooth's onboarding) sets; no EdgeWorkers account was available to run it.
- **WordPress.org listing**: the directory requires a GPL-compatible license; `readme.txt` carries `LicenseRef-Trooth-Proprietary` as every file does. A founder decision before submission.
- **Connector keys in the dashboard**: a place under Delivery, Connectors to paste a connector's public JWK, per source, with the key id shown.
- **Hosted copies** (`llms.txt`, `sitemap.md`, `keys.json`, `by-path`) exist once the serve module ships; nothing here was run against a live API.

## How to run the tests

```
npx vitest run test/adapters.test.ts
npx tsc --noEmit
```

Both pass for these files (`tsc` reports one error in `test/verifier.test.ts`, another area's file). The PHP files pass `php -l`; the three Node scripts pass `node --check`.
