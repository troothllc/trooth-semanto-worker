# Semanto adapter for Gcore FastEdge

FastEdge runs WebAssembly at Gcore's edge. Rust is the native target; this folder is the JavaScript variant Gcore supports through its JS SDK, which compiles `src/index.js` to a `.wasm` you upload.

## Build and upload

```
cd adapters/gcore-fastedge
npm install
npm run build          # writes dist/trooth-semanto.wasm
```

Then, in the Gcore panel:

1. **FastEdge, Applications, Create**: upload `dist/trooth-semanto.wasm`. Under Environment variables add `TROOTH_ID`, `MODE` (`semanto_only`, `semanto_then_cloudflare_for_unsigned` or `proof_only`), `TROOTH_API_BASE` (`https://api.trooth.co`) and `ORIGIN_HOST` (your site's origin hostname).
2. **CDN, your resource, Rules**: add a rule and attach the FastEdge app at the **on request** stage.

## The CDN rule

Two choices, depending on how much you want the app to see:

- **All requests** (recommended): rule pattern `/*`. The app decides on `Accept` and path suffix, serves what is Trooth's and fetches your origin for the rest, adding the `Trooth-Semanto-Version` and `Link` headers to HTML.
- **Paths only** (`proof_only` style): one rule with a regular expression on the path, `^/(\.well-known/trooth\.semanto|\.well-known/trooth-keys\.json|llms\.txt|llms-full\.txt|sitemap\.md|.*\.md|.*\.jsonld)$`. Requests that ask for markdown by `Accept` header alone are not covered by a path rule; use the first choice if you want those.

Allow outbound requests from the app to `api.trooth.co` and to your origin in the app's settings if your account restricts them.

## What the app never does

It never reads `User-Agent`. The decision table is in `adapters/README.md`.
