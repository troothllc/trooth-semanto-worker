# Semanto adapter for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/troothllc/trooth-semanto-worker/tree/main/deploy/cloudflare)

The button deploys `deploy/cloudflare`, this folder and `shared/` in one, built by `scripts/build-deploy.mjs`.

Your site stays where it is. This Worker sits on your Cloudflare zone and does one thing: when a reader asks for a page as markdown or JSON-LD, or asks for one of the Trooth files, it answers with the signed copy Trooth holds for you, byte for byte, with the signature headers. Every other request goes to your site untouched.

## What it serves

| Request | Answer |
| --- | --- |
| Any page with `Accept: text/markdown` or `text/*`, or a path ending in `.md` or `/index.md` | The signed markdown of that page |
| Any path with `Accept: application/ld+json`, or ending in `.jsonld` or `/facts.jsonld` | Your signed facts file |
| `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json` | Your Semanto file and your public keys |
| `/llms.txt`, `/llms-full.txt`, `/sitemap.md` | The Trooth-built copies |
| Everything else | Your site, as before, plus two headers on HTML pages (`Trooth-Semanto-Version` and `Link`) that tell agents where the signed copy is |

The decision is made only on the `Accept` header and the path. The Worker never looks at `User-Agent`.

## Download

The package with this folder and `shared/` is at https://trooth.co/docs/semanto/install/cloudflare-worker, with the steps.

## Install from the command line

```
cd adapters/cloudflare-worker
npm install
# edit wrangler.toml: TROOTH_ID, MODE and the route pattern
npx wrangler deploy
```

## The three settings

- `TROOTH_ID`: your Trooth ID from the dashboard.
- `TROOTH_API_BASE`: `https://api.trooth.co`. Leave it.
- `MODE`:
  - `semanto_only`: the Worker answers every markdown and JSON-LD request from the signed copy. A page Trooth has not signed gets a plain markdown "not found" page from Trooth, never an unsigned conversion.
  - `semanto_then_cloudflare_for_unsigned`: the Worker answers only the pages listed in your current Semanto. For the rest it steps aside, so Cloudflare's own Markdown for Agents conversion (if you turned it on in the dashboard) handles them. The Worker fetches your manifest once and keeps it for five minutes with its ETag.
  - `proof_only`: the Worker serves only the two `/.well-known` files and adds the `Trooth-Semanto-Version` and `Link` headers to your HTML. Markdown stays with Cloudflare or your origin.

## Check it worked

```
curl -sI https://yourdomain.com/.well-known/trooth.semanto | grep -i -E "signature|trooth"
curl -s -H "Accept: text/markdown" https://yourdomain.com/ | head
```

Both should show `Signature-Input`, `Signature`, `Content-Digest` and `Trooth-Semanto-Version`.

## Cost

A Worker on the free plan covers 100,000 requests a day. Only requests the Worker serves itself make a call to Trooth; HTML requests are passed through with one subrequest to your origin, as before.
