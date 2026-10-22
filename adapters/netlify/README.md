# Semanto adapter for Netlify

Two ways to install. The edge function is the full adapter. The `_redirects` lines are the two-line fallback that only serves the well-known files.

## Option 1: the edge function (full adapter)

1. Copy `netlify/edge-functions/semanto.ts` into your site's `netlify/edge-functions/` folder, and copy `adapters/shared/` to `shared/` at the root of your repository (the import path in the function is `../../shared/semanto-adapter.mjs`).
2. Add the `[[edge_functions]]` block from `netlify.toml` to your own `netlify.toml`.
3. Set the environment variables:

```
netlify env:set TROOTH_ID your-trooth-id
netlify env:set MODE semanto_only
netlify deploy --prod
```

The function runs on every request. It answers markdown and JSON-LD requests (decided on `Accept` and path suffix, never on `User-Agent`), the two `/.well-known` files, `llms.txt`, `llms-full.txt` and `sitemap.md` from the signed copy, and calls `context.next()` for everything else so your site answers as before. HTML answers get two extra headers, `Trooth-Semanto-Version` and `Link`, that tell agents where the signed copy is. `onError: "bypass"` means that if the function ever fails, your site still serves.

## Option 2: two lines in `_redirects` (well-known files only)

Copy the two lines from `_redirects` into your `_redirects` file (or `public/_redirects`) and replace `example-inc` with your Trooth ID. The `200!` at the end makes Netlify proxy the request and send the body back under your domain. This covers `/.well-known/trooth.semanto` and `/.well-known/trooth-keys.json` and nothing else; markdown requests still go to your site.

## Modes

- `semanto_only`: every markdown or JSON-LD request is answered from the signed copy.
- `semanto_then_cloudflare_for_unsigned`: only the pages listed in your current Semanto; others fall through. The manifest is fetched once and kept with its ETag for five minutes per edge instance.
- `proof_only`: only the two well-known files, plus the headers on HTML.

## Check it worked

```
curl -sI https://yourdomain.com/.well-known/trooth.semanto | grep -i signature
curl -s -H "Accept: text/markdown" https://yourdomain.com/ | head
```
