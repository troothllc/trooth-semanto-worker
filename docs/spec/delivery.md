<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- How a Semanto is delivered: the settings model, the three markdown-source modes, the three when-a-page-changed choices, the no-duplicate rule, and the host table. Follows src/settings/delivery.ts, src/serve, adapters/README.md, RFC 9110 content negotiation, and Cloudflare's Markdown for Agents (changelog, 26 February 2026). -->

# Delivery

A Semanto is served from two places with the same bytes: the Trooth-hosted copy at `https://api.trooth.co/public/semanto/{trooth_id}/`, always on, and the company's own domain through a host adapter when the company turns it on. The settings below choose how the own-domain copy behaves. The reference implementation is `src/settings/delivery.ts` (the model, validation and the pure resolver), `src/serve/` (the routes and headers), `src/serve/detect.ts` (host detection) and `adapters/` (one adapter per host). The dashboard panel for these settings is `web/semanto/delivery-settings-panel.tsx`.

## The one rule that governs delivery

The format of an answer is chosen by what the reader asks for, through the `Accept` header or a path suffix, and never by who the reader says it is. Nothing in Semanto reads `User-Agent`. Two readers of the same URL with the same `Accept` get the same bytes, and a test fails if they do not. Every representation carries the same content as the HTML. Serving by user agent is cloaking under Google's spam policies (clarified for AI Overviews and AI Mode on 15 May 2026); serving by `Accept` is content negotiation (RFC 9110 section 12.5.1).

The negotiation table matches Cloudflare's documented outcomes, so an agent gets the same answer from a Semanto-served page as from a Cloudflare-converted one:

| Request | Answer |
| --- | --- |
| `Accept: text/markdown` | markdown |
| `Accept: text/markdown, text/html;q=0.9` | markdown |
| `Accept: text/*` | markdown when offered first, else HTML |
| `Accept: */*` or no Accept | HTML (a browser) |
| `Accept: application/ld+json` | the facts as JSON-LD |
| `Accept: text/markdown;q=0` | HTML |
| path ending in `.md` or `/index.md` | markdown |
| path ending in `.jsonld` or `/facts.jsonld` | JSON-LD |

## The settings

`POST /os/semanto/{trooth_id}/settings` accepts this object (`DeliverySettings` in `src/settings/delivery.ts`). Every member is validated with a plain-words message; the cross-field rules are listed after the table.

| Setting | Values | Meaning |
| --- | --- | --- |
| `where.trooth_hosted` | always `true` | The Trooth-hosted copy cannot be turned off. The proofs and the public log point at it. |
| `where.own_domain` | `true` or `false` | Serve the same bytes from the company's domain through an adapter. |
| `host` | `cloudflare`, `vercel`, `netlify`, `fastly`, `akamai`, `gcore`, `nginx`, `apache`, `wordpress`, `head_tag`, `unknown` | Which adapter applies. Detection (`src/serve/detect.ts`) suggests it from response headers, the body and a DNS-over-HTTPS lookup; the company confirms it. |
| `formats.whole_file` | always `true` | `/.well-known/trooth.semanto` and the JSON file. |
| `formats.markdown` | `true` or `false` | Markdown for each page on `Accept: text/markdown` or `.md`. |
| `formats.jsonld` | `true` or `false` | The facts as JSON-LD (`/facts.jsonld` and per page). |
| `formats.llms` | `true` or `false` | `/llms.txt` and `/llms-full.txt`. |
| `formats.sitemap_md` | `true` or `false` | `/sitemap.md`. |
| `markdown_source` | see [Markdown source](#markdown-source) | Where the markdown an agent reads comes from. |
| `when_page_changed` | see [When a page changed](#when-a-page-changed) | What happens when a live page moves on after signing. |
| `content_signals` | `ai-train`, `search`, `ai-input`, each `true` or `false` | Written into the signed controls and sent as `Content-Signal` (contentsignals.org form `ai-train=no, search=yes, ai-input=yes`). They state the company's terms. They do not block anyone and never change what is served. |

Defaults: own domain off, host unknown, every format on, `semanto_only`, `serve_last_signed_marked_behind`, `ai-train` off and `search` and `ai-input` on.

Cross-field rules: a markdown source other than `semanto_only` needs `host` to be `cloudflare`, because only Cloudflare runs a markdown converter. Markdown off with a source other than the proof-only mode is refused, because Semanto cannot be the markdown source when markdown is off. A host adapter other than `unknown` or `head_tag` needs own domain on.

## Markdown source

| Mode | What readers get | Proof |
| --- | --- | --- |
| `semanto_only` | Semanto answers every markdown and JSON-LD request with the signed bytes. A page that is not in the signed file gets a not-found notice in markdown, never an unsigned conversion. | Every page checkable. |
| `semanto_then_cloudflare_for_unsigned` | Semanto answers first for every signed page, so the host's converter never touches them. Pages that are not signed fall through to Cloudflare's converter with `Trooth-Semanto-State: unsigned`. | Signed pages checkable; the rest carry no proof and say so. |
| `cloudflare_format_semanto_proof_only` | Cloudflare's converter answers every markdown request. Semanto serves the signed file, the facts, `llms.txt` and the proofs only. | The whole file and the facts checkable. Individual pages are not, because the converter's bytes change on every request and are not the bytes that were signed. The dashboard shows this warning whenever the mode is selected. |

## When a page changed

The monitor notices a live page that no longer matches its signed bytes (sitemap `lastmod`, HTTP validators, content hash, a rolling re-read). Until a new version is signed, the setting decides what a reader gets for that page:

| Choice | Behaviour |
| --- | --- |
| `serve_last_signed_marked_behind` | The last signed bytes, with `Trooth-Semanto-State: behind`. The reader gets something checkable and knows the live page moved on. |
| `serve_live_marked_unsigned` | The live page through the host, with `Trooth-Semanto-State: unsigned`. The reader gets the current words and knows they are not signed. The signed version stays available by its version number. |
| `prompt_to_sign` | The last signed bytes marked behind, and the company is asked to sign the new version. |

No choice ever serves the live page as if it were signed.

## The no-duplicate rule

On a host with its own markdown converter (Cloudflare), a signed page must never exist as two different markdown documents at the same URL, one signed by the company and one produced by the converter. The resolver enforces it: for a signed page, Semanto answers first in every mode except the proof-only mode, so the converter never sees the request; in the proof-only mode Semanto never answers page markdown at all. An agent therefore gets one markdown document per URL, and the `Trooth-Semanto-Version` and `Trooth-Page-Hash` headers tell it whether that document is the signed one. The same rule is why HTML is always the host's: Semanto never serves HTML, so there is never a second HTML.

## What is always Semanto's

Whatever the mode, these paths on the company's domain are answered from the signed copy when own domain is on: `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json`, and, when their formats are on, `/llms.txt`, `/llms-full.txt`, `/sitemap.md`, `/facts.jsonld`. `llms.txt` is unsigned by nature; it points at the signed file and its digest.

## Host table

| Host | What the platform allows | Adapter or fallback |
| --- | --- | --- |
| Cloudflare (proxied zone) | A Worker route on the zone | `adapters/cloudflare-worker/` |
| Vercel (Next.js) | Middleware and route handlers; `/.well-known` cannot be rewritten | `adapters/vercel/`: middleware plus route handler; the two well-known files as static files written at build |
| Netlify | Edge functions; `_redirects` with `200!` | `adapters/netlify/`: edge function, or two `_redirects` lines for the well-known files only |
| Fastly | Compute services | `adapters/fastly-compute/` |
| Akamai | EdgeWorkers | `adapters/akamai-edgeworkers/` |
| Gcore | FastEdge apps | `adapters/gcore-fastedge/` |
| nginx | `map` and `proxy_pass` | `adapters/nginx/`, `semanto_only` or proof-only |
| Apache httpd | `mod_rewrite` and `mod_proxy` | `adapters/apache/`, `semanto_only` or proof-only |
| WordPress | Plugins | `adapters/wordpress-plugin/`, with WooCommerce product send |
| WordPress.com | Plugins on plans that allow them | The plugin where allowed; otherwise the head tag and the DNS pointer |
| Shopify | No custom root paths; `llms.txt` through theme templates | `adapters/head-tag/` plus `adapters/commerce-platforms/shopify/` for products |
| Webflow | Head code; well-known files on Enterprise only | `adapters/head-tag/`; Enterprise uploads the two well-known files |
| Squarespace, Wix | Head code only | `adapters/head-tag/`; DNS pointer and the Trooth-hosted copy |
| BigCommerce, Salesforce Commerce | Storefront head code; catalog APIs | `adapters/head-tag/` plus `adapters/commerce-platforms/` |

Where no code can run, the head tag (`<link rel="https://trooth.co/rel/semanto">`, `<link rel="alternate" type="text/markdown">`, and the JSON-LD block) points at the Trooth-hosted copy, and the `_trooth` DNS pointer plus the `_trooth-keys` key record prove the binding. An agent finds the file from any of four places: DNS, the `Link` header, `llms.txt`, or the Trooth Network.

## Every served answer has the full header set

Pages, parts of a long page, the facts, `llms.txt`, `llms-full.txt`, `sitemap.md` and the whole file all carry the headers in `docs/spec/response-signatures.md`, including the signature. An adapter copies them byte for byte from the Trooth-hosted answer; it adds nothing and removes nothing except hop-by-hop headers.
