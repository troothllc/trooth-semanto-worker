# Semanto host adapters

Every adapter does the same job on the customer's own domain: when a reader asks for a page as markdown or JSON-LD, or asks for one of the Trooth files, answer with the bytes of the Trooth-hosted signed copy, byte for byte, with every header the API sent. Otherwise pass the request to the host untouched. The adapters talk only to the public API (`https://api.trooth.co/public/semanto/{trooth_id}/` and the routes under it), never to internal modules.

## The decision, the same everywhere

Only two inputs: the `Accept` header and the path suffix. Never `User-Agent` (serving by user agent is cloaking under Google's spam policies, clarified 15 May 2026; serving by Accept is not).

| Request | Answer |
| --- | --- |
| `Accept: text/markdown` | the page's signed markdown |
| `Accept: text/markdown, text/html;q=0.9` | markdown |
| `Accept: text/*` | markdown |
| `Accept: text/html, text/markdown;q=0.5` | the host's HTML |
| `Accept: */*`, or no Accept header | the host's HTML (a browser) |
| `Accept: application/ld+json` | the signed facts file (JSON-LD) |
| `Accept: text/markdown;q=0` | the host's HTML |
| path ends in `.md` or `/index.md` | markdown, whatever the Accept header says |
| path ends in `.jsonld` or `/facts.jsonld` | the facts file, whatever the Accept header says |
| `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json` | the Semanto file and the public keys |
| `/llms.txt`, `/llms-full.txt`, `/sitemap.md` | the Trooth-built copies |
| anything else, or a method other than GET and HEAD | the host, untouched; HTML gets `Trooth-Semanto-Version` and `Link` headers |

These outcomes are the ones Cloudflare's Markdown for Agents documents (changelog, 26 February 2026), so an agent gets the same answer from a Semanto-served page as from a Cloudflare-converted one. The nginx and Apache adapters use regular expressions that give the same answer for every row above; on an exact tie such as `text/html, text/markdown` they give HTML, the code adapters give markdown.

## Headers forwarded from the API

`Content-Type`, `ETag`, `Vary`, `Content-Digest`, `Signature-Input`, `Signature`, `Trooth-Contract`, `Trooth-Semanto-Version`, `Trooth-Page-Hash`, `Trooth-Signed-Page-Hash`, `Trooth-Signed-By`, `Trooth-Semanto-State`, `Location`, `Link`, `Content-Signal`, `x-markdown-tokens`, `x-original-tokens`, `Cache-Control`. Nothing else (no cookies, no server banners). No header carries an `X-` prefix (RFC 6648). Every answer, including errors and HTML passed to a browser, carries `Vary: Accept`, merged into any `Vary` already present.

## Fail safe

An adapter never takes a site down.

| Rule | Value |
| --- | --- |
| Deadline for a file | 1.5 seconds |
| Deadline for the manifest | 0.8 seconds; a stored manifest answers at once and a fresh one is fetched in the background |
| API slow, unreachable or 5xx | the last good copy, signed while its signature is valid (`Trooth-Delivery: stale`), the same copy without its signature after that (`stale-unsigned`), else the site's own page (`host`) |
| Breaker | after 3 failures in 30 seconds the adapter stops asking for 30 seconds, then lets one request through |
| The adapter's own status codes | never 5xx; the API's 4xx pass through unchanged |
| Stored copies | at most 24 hours old, sent with `Cache-Control: no-store` |

Every answer the adapter serves says where its bytes came from in `Trooth-Delivery`: `trooth`, `stale`, `stale-unsigned` or `host`. nginx and Apache carry the same rules in their own terms (timeouts, `proxy_cache_use_stale`, an error page that is the site's own). The Vercel build step never writes `Signature` or `Signature-Input` into `vercel.json`, because a response signature lasts about an hour and a static header would outlive it.

## JSON-LD mapping

`/facts.jsonld` at the site root, or `Accept: application/ld+json` there, is the company's facts. Any other path asked for as JSON-LD (by `Accept` or a `.jsonld` suffix) is that page's JSON-LD at `by-path/{path}.jsonld`, never the facts. A page asked for as markdown is fetched with a `.md` suffix so the API returns markdown whatever `Accept` the reader sent. A cross-check test runs every request shape through each adapter and through the API and compares the bytes.

## The three settings

| Setting | Values |
| --- | --- |
| `TROOTH_ID` | the company's Trooth ID |
| `TROOTH_API_BASE` | `https://api.trooth.co` |
| `TROOTH_CONNECTOR_KEY` | the company's connector private key (an Ed25519 JWK, kept in the platform's secret store: a Worker secret, Fastly Secret Store, Gcore `getSecret`, Netlify or Vercel environment variable, an Akamai property variable, a WordPress option). With it, an agent's Web Bot Auth signature is forwarded to the API with `Trooth-Forwarded-Authority` and `Trooth-Forwarded-For` and signed by the adapter (`Trooth-Connector-Signature-Input`, `Trooth-Connector-Signature`), so the read counts as that agent's. Without it, reads through the adapter are unproven readers. The public half is registered in the workspace under connectors. |
| `MODE` | `semanto_only`: every markdown and JSON-LD request from the signed copy; a page Trooth has not signed gets Trooth's markdown "not found", never an unsigned conversion. `semanto_then_cloudflare_for_unsigned`: only pages the current manifest lists (the manifest is fetched once and kept with its ETag); the rest go to Cloudflare's converter or the host. `proof_only`: only the two `/.well-known` files, plus the two headers on HTML. |

## Which adapter for which host

From the launch blueprint (16 October 2026), with what each platform allows:

| Host | What the platform allows | Adapter or fallback |
| --- | --- | --- |
| Cloudflare (proxied zone) | A Worker route on the zone; the Cache API for the manifest | `cloudflare-worker/`: Deploy button or `wrangler deploy` |
| Vercel (Next.js) | Middleware and route handlers for any path; **`/.well-known` is reserved and cannot be redirected or rewritten** | `vercel/`: middleware plus route handler for pages, facts and llms files; the two well-known files as static `public/` files written at build by `scripts/semanto-sync.mjs`, with their headers in `vercel.json`. W5 tests that a static file serves; expectation and fallback in the README |
| Netlify | Edge functions on any path; `_redirects` with `200!` proxies a path | `netlify/`: edge function (full) or two `_redirects` lines (well-known only) |
| Fastly | Compute services with named backends | `fastly-compute/`: JavaScript service, `fastly compute publish` |
| Akamai | EdgeWorkers with `httpRequest` and `request.route()` to a conditional origin | `akamai-edgeworkers/`: `main.js` and `bundle.json`, `build.sh` makes the tarball |
| Gcore | FastEdge apps (Rust native, JavaScript through the SDK) attached to a CDN rule | `gcore-fastedge/`: JavaScript app and the rule description |
| nginx (self-hosted) | `map` and `proxy_pass` | `nginx/`: three conf files, `semanto_only` or `proof_only` |
| Apache httpd (self-hosted) | `mod_rewrite` and `mod_proxy` | `apache/`: one conf file, `semanto_only` or `proof_only` |
| WordPress (any host that passes `/.well-known` to PHP) | Plugins | `wordpress-plugin/`: the full plugin, with WooCommerce product send |
| WordPress.com | Plugins on plans that allow them | Same plugin where allowed; otherwise the DNS pointer and the Network copy |
| Shopify | **No custom root paths for apps** (app proxies live under `/a/`, `/apps/`, `/community/`, `/tools/`); `/llms.txt`, `/llms-full.txt` and `/agents.md` through theme templates since 28 May 2026 | `head-tag/`: the three tags in `theme.liquid` plus the `llms.txt` and `agents.md` templates; products through `commerce-platforms/shopify/` |
| Webflow | Custom head code on paid plans; **well-known files only on Enterprise workspaces** (`.txt` or `.json` under 100 KB); `llms.txt` upload on other plans | `head-tag/`: tags; Enterprise uploads the two well-known files; others add pointer lines to `llms.txt` |
| Squarespace | Code injection in the header; **no root directory** | `head-tag/`: tags only; DNS pointer and the Network copy |
| Wix | Custom code in the head; serves some `/.well-known` paths itself on connected domains | `head-tag/`: tags only; DNS pointer and the Network copy |
| BigCommerce, Salesforce Commerce | Storefront head code; catalog APIs | `head-tag/` tags on the storefront; products through `commerce-platforms/` |

In every case the canonical Semanto lives on the Trooth Network, byte-identical and signed by the company, and the `_trooth` DNS record proves the binding. An agent finds the file from any of four places: DNS, the `Link` header, `llms.txt`, or the Network. The adapters add the served copy wherever the platform allows it.

## Folders

| Folder | Contents |
| --- | --- |
| `shared/` | `semanto-adapter.mjs`: `decide`, `copyHeaders`, `createManifestCache`, `handleRequest`; `sign-request.mjs`: signed POSTs for the commerce connectors. No dependencies. Tested in `test/adapters.test.ts` |
| `cloudflare-worker/` | `src/index.ts`, `wrangler.toml`, README with the Deploy to Cloudflare button |
| `vercel/` | `middleware.ts`, `lib-semanto.ts`, `app/semanto/[[...path]]/route.ts`, `scripts/semanto-sync.mjs`, `vercel.json` |
| `netlify/` | `netlify/edge-functions/semanto.ts`, `netlify.toml`, `_redirects` |
| `fastly-compute/` | `fastly.toml`, `src/index.js`, `package.json` |
| `akamai-edgeworkers/` | `main.js`, `bundle.json`, `build.sh` |
| `gcore-fastedge/` | `src/index.js`, `package.json`, the CDN rule in the README |
| `nginx/` | `semanto-maps.conf`, `semanto-proxy.conf`, `semanto-server.conf` |
| `apache/` | `semanto.conf` |

nginx and Apache cannot sign the forwarding. They clear any `Trooth-Forwarded-*` and `Trooth-Connector-*` header a client sent and do not forward agent identity, so a read through them is an "unproven reader" unless the agent's request reaches `api.trooth.co` directly. Use a code adapter in front of them when proven reads matter.
| `wordpress-plugin/` | `trooth-semanto/` (the plugin), README with the connector endpoint |
| `head-tag/` | The tags to paste for Webflow, Squarespace, Wix and Shopify; Shopify `llms.txt` and `agents.md` templates |
| `commerce-platforms/` | Shopify, BigCommerce and Salesforce Commerce scripts; WooCommerce points at the plugin |

## API routes the adapters call

Relative to `{TROOTH_API_BASE}/public/semanto/{trooth_id}`:

| Route | Used for |
| --- | --- |
| (root) | the Semanto file, which is also the manifest (`header.pages_manifest` maps each page url to its `smp_` id) |
| `/keys.json` | the public JWK Set served as `/.well-known/trooth-keys.json` |
| `/facts.jsonld` | the facts file |
| `/llms.txt`, `/llms-full.txt`, `/sitemap.md` | the three text files |
| `/pages/{smp_id}` | a page listed in the manifest |
| `/by-path{path}` | a page by its path on the customer's domain, for the proxies that cannot read the manifest and for `semanto_only` when the cached manifest does not list the page; the API resolves it through the current version |

The commerce connectors POST to `{TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog`.

## Tests

```
npx vitest run test/adapters.test.ts
npx tsc --noEmit
```
