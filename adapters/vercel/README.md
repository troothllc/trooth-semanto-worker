# Semanto adapter for Vercel (Next.js)

Your Next.js site keeps running as it does. Three small files make it answer markdown and JSON-LD requests with the signed copy Trooth holds for you, and serve the two Trooth files under `/.well-known`.

## What goes where

| File | Copy to | Does |
| --- | --- | --- |
| `middleware.ts` | project root (Next.js 16: name it `proxy.ts`) | Decides on `Accept` and path suffix, rewrites what it serves to `/semanto/` plus the original path, adds `Trooth-Semanto-Version` and `Link` to HTML |
| `lib-semanto.ts` | project root | Reads the three settings, keeps the manifest with its ETag |
| `app/semanto/[[...path]]/route.ts` | same path in your app | Fetches the bytes from Trooth and returns them with the API's headers |
| `scripts/semanto-sync.mjs` | `scripts/` | At build time, downloads `/.well-known/trooth.semanto` and `/.well-known/trooth-keys.json` into `public/` and writes their headers into `vercel.json` |
| `vercel.json` | project root (merge if you have one) | Build command and the static headers |
| `shared/` | project root | Copy of `adapters/shared/` (two files, no dependencies) |

## Install

```
# from the root of your Next.js project
cp -r path/to/adapters/vercel/{middleware.ts,lib-semanto.ts,app,scripts,vercel.json} .
cp -r path/to/adapters/shared ./shared
vercel env add TROOTH_ID
vercel env add MODE            # semanto_only | semanto_then_cloudflare_for_unsigned | proof_only
vercel deploy --prod
```

Then, in the Trooth dashboard under Delivery, paste a Vercel Deploy Hook URL. Trooth calls it when it publishes a new version of your Semanto, so the static well-known files are rebuilt.

## Why the well-known files are static

Vercel's documentation says the `/.well-known` path is reserved and cannot be redirected or rewritten. So the middleware does not touch it. Instead `scripts/semanto-sync.mjs` runs before `next build`, downloads the two files, puts them in `public/.well-known/`, and copies the headers the API sent (`Signature-Input`, `Signature`, `Content-Digest`, `ETag`, `Trooth-Semanto-Version`) into `vercel.json` so the static copies still carry their proof.

**Test W5 and what to expect.** Vercel's reservation is documented for rewrites and redirects, not for static files, so a static file at `public/.well-known/trooth.semanto` is expected to serve. The W5 test is:

```
curl -sI https://yourdomain.com/.well-known/trooth.semanto
```

Expected: `200`, `Content-Type: application/json`, a `Signature` header. If W5 fails on your project, nothing else breaks: the canonical copy stays on the Trooth Network, your `_trooth` DNS record points at it, and the `Link` header on every HTML page names it. Tell Trooth the result either way.

## Modes

- `semanto_only`: every markdown or JSON-LD request is answered from the signed copy.
- `semanto_then_cloudflare_for_unsigned`: only pages listed in your current Semanto are answered; the rest fall through to your site (or to Cloudflare in front of Vercel, if you use it).
- `proof_only`: only the headers on HTML; markdown stays with your site. The well-known files are still built as static files.

## Check it worked

```
curl -s -H "Accept: text/markdown" https://yourdomain.com/ | head
curl -sI https://yourdomain.com/pricing | grep -i -E "link|trooth"
```
