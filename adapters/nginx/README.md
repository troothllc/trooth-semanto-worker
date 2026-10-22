# Semanto adapter for nginx

Three small files. No module to compile, no code to run; nginx proxies the right requests to the signed copy Trooth holds for you and passes the headers through.

## Install

```
sudo cp semanto-maps.conf semanto-proxy.conf /etc/nginx/
# 1. in /etc/nginx/nginx.conf, inside http { }:
#        include /etc/nginx/semanto-maps.conf;
# 2. paste the contents of semanto-server.conf into your server { } block
# 3. replace example-inc with your Trooth ID in both semanto-maps.conf and the pasted block
sudo nginx -t && sudo systemctl reload nginx
```

## How it decides

- `semanto-maps.conf` turns the `Accept` header and the path suffix into one variable, `$semanto_rep`: `1` for markdown, `2` for JSON-LD, `0` for your site. It never reads `$http_user_agent`.
- `semanto-server.conf` proxies `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json`, `/llms.txt`, `/llms-full.txt` and `/sitemap.md` to the Trooth-hosted copies, and inside `location /` proxies markdown requests to the API's `by-path` route and JSON-LD requests to the facts file.
- `semanto-proxy.conf` sets the upstream host, passes `Accept` and `If-None-Match` through, names every Trooth header with `proxy_pass_header`, and hides cookies and server headers.

Outcomes the maps give:

| Accept | Result |
| --- | --- |
| `text/markdown` | markdown |
| `text/markdown, text/html;q=0.9` | markdown |
| `text/*` | markdown |
| `text/html, text/markdown;q=0.5` | your site |
| `*/*` or no header | your site |
| `application/ld+json` | facts (JSON-LD) |
| `text/markdown;q=0` | your site |

Path suffix wins: `/pricing.md`, `/pricing/index.md` give markdown and `/facts.jsonld`, `/pricing.jsonld` give the facts file, whatever the Accept header says.

## Modes

nginx has no manifest, so two of the three modes apply:

- `semanto_only` (the files as written): every markdown and JSON-LD request goes to the API, which answers from your current signed version.
- `proof_only`: keep only the two `/.well-known` locations and the `add_header Link` line in your own `location /`.

`semanto_then_cloudflare_for_unsigned` needs the manifest; if your nginx sits behind Cloudflare, use the Cloudflare Worker adapter for that mode.

## Check it worked

```
curl -sI https://yourdomain.com/.well-known/trooth.semanto | grep -i signature
curl -s -H "Accept: text/markdown" https://yourdomain.com/ | head
curl -sI https://yourdomain.com/ | grep -i link
```
