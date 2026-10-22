# Semanto adapter for Akamai EdgeWorkers

An EdgeWorker that decides, on `Accept` and path suffix only, whether a request is answered from the signed copy Trooth holds for you or by your origin as before.

## What you need in the property

1. A **conditional origin** named `trooth_api` pointing at `api.trooth.co` (Origin Server behavior, hostname `api.trooth.co`, forward the incoming Host header as origin hostname). `request.route()` sends served requests to it, so the body streams back at any size with the API's headers.
2. The **EdgeWorkers behavior** on the whole hostname (or just `/.well-known/*` for `proof_only`).
3. Three **user-defined variables** (Property Manager, Variables): `PMUSER_TROOTH_ID`, `PMUSER_TROOTH_MODE`, `PMUSER_TROOTH_API_BASE`, plus `PMUSER_SEMANTO_SERVED` which the code sets. If you prefer, edit the `DEFAULTS` at the top of `main.js` instead.

## Install in one command

```
cd adapters/akamai-edgeworkers
./build.sh
akamai edgeworkers upload --bundle trooth-semanto-edgeworker.tgz <edgeworker-id>
akamai edgeworkers activate <edgeworker-id> PRODUCTION <version>
```

## What happens on each request

- `onClientRequest`: reads the manifest with `httpRequest` (once, then every five minutes with `If-None-Match`), runs the shared decision and either routes to `trooth_api` or lets the request through.
- `onClientResponse`: on your own HTML, adds `Trooth-Semanto-Version` and `Link` so agents can find the signed copy. On served responses it changes nothing.

The EdgeWorker never reads `User-Agent`.

## Modes

Same three as every adapter: `semanto_only`, `semanto_then_cloudflare_for_unsigned` (listed pages only; the rest go to origin) and `proof_only` (the two well-known files and the HTML headers).
