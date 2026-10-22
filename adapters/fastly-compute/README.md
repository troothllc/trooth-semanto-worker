# Semanto adapter for Fastly Compute

A small Compute service in JavaScript that sits in front of your site. It answers markdown, JSON-LD and the Trooth well-known files from the signed copy Trooth holds for you, with the signature headers, and sends everything else to your origin as before.

## Install in one command

```
cd adapters/fastly-compute
npm install
fastly compute publish
```

`fastly compute publish` reads the `[setup]` block in `fastly.toml` and asks you, once, for:

- the `origin` backend (your website's hostname),
- the `trooth_api` backend (leave `api.trooth.co`),
- the three settings in the `trooth_semanto` Config Store: `TROOTH_ID`, `MODE`, `TROOTH_API_BASE`.

Then point your domain at the new service in the Fastly UI (Domains).

## How it decides

Only the `Accept` header and the path suffix (`.md`, `/index.md`, `.jsonld`, `/facts.jsonld`). The service never reads `User-Agent`. The decision table is in `adapters/README.md`.

## Modes

- `semanto_only`: all markdown and JSON-LD requests from the signed copy.
- `semanto_then_cloudflare_for_unsigned`: only pages listed in the current manifest; others go to origin. The manifest is fetched once per instance and kept with its ETag for five minutes.
- `proof_only`: the two well-known files only, plus the headers on HTML.

## Local run

```
fastly compute serve
curl -s -H "Accept: text/markdown" http://127.0.0.1:7676/ | head
```
