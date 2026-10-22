# Head tag adapter: Webflow, Squarespace, Wix, Shopify

Where no code can run on your domain, three lines in the page head point readers at the signed copy Trooth holds for you. Nothing is served from your domain; the Trooth Network serves it, your `_trooth` DNS record proves the binding, and these tags make the copy findable from any page.

Replace `example-inc` with your Trooth ID and `PAGE_ID` with the page's id from your Semanto (the dashboard shows it next to each page; the site-wide tags need no page id).

## The tags

Site-wide, on every page (paste once in the site header):

```html
<link rel="https://trooth.co/rel/semanto" href="https://api.trooth.co/public/semanto/example-inc">
<script type="application/ld+json" src="https://api.trooth.co/public/semanto/example-inc/facts.jsonld"></script>
```

Per page, pointing at that page's signed markdown (optional; the site-wide tags already lead to every page through the Semanto file):

```html
<link rel="alternate" type="text/markdown" href="https://api.trooth.co/public/semanto/example-inc/pages/PAGE_ID">
```

A note on the script tag: browsers do not fetch `<script type="application/ld+json" src>`, and Google reads JSON-LD only when it is inline. The tag above is a pointer for agents that read the head; if you want search engines to read the facts, paste the contents of `facts.jsonld` inline instead (the dashboard has a "copy inline block" button) and refresh it when Trooth publishes a new version.

## Webflow

Site settings, Custom Code, Head Code: paste the two site-wide tags. Per page: Page settings, Custom Code, Inside head tag.

**Enterprise workspaces** can host files under `/.well-known` (text or JSON, under 100 KB) through the Well-Known Files setting (Site settings, Publishing). Upload `trooth.semanto` and `trooth-keys.json` downloaded from `https://api.trooth.co/public/semanto/example-inc` and `https://api.trooth.co/public/semanto/example-inc/keys.json`. Both are usually well under 100 KB; the dashboard shows the current size. Static uploads lose the signature headers and go stale when you publish a new version, so keep the head tags too, and re-upload when Trooth notifies you.

Other Webflow plans can upload an `llms.txt` (Site settings, SEO): add the pointer lines from the Shopify section below.

## Squarespace

Settings, Advanced, Code Injection, Header: paste the two site-wide tags. Squarespace has no root directory, so there is no `/.well-known` and no `llms.txt`; the DNS record and the head tags do the work.

## Wix

Settings, Custom Code, add code to Head on all pages: paste the two site-wide tags. Wix serves some `/.well-known` paths itself on connected domains; a custom file there is not available on classic Wix sites. Rely on the DNS record and the tags.

## Shopify

Online Store, Themes, Edit code, `layout/theme.liquid`, inside `<head>`: paste the two site-wide tags.

Shopify allows no custom root paths for apps (app proxies live under `/a/`, `/apps/`, `/community/` or `/tools/`), so `/.well-known/trooth.semanto` cannot be served from a store. Since 28 May 2026 stores can customise `/llms.txt`, `/llms-full.txt` and `/agents.md` through theme templates. The snippets are in this folder:

- `shopify/templates/llms.txt.liquid`
- `shopify/templates/agents.md.liquid`

Each adds pointer lines to the Trooth-hosted copies. Create the templates in the theme editor (Add a new template, type `llms.txt` and `agents.md`) and paste the contents. The pointer lines are:

```
# Semanto by Trooth
Signed copy of this site: https://api.trooth.co/public/semanto/example-inc
Markdown sitemap: https://api.trooth.co/public/semanto/example-inc/sitemap.md
Facts (JSON-LD): https://api.trooth.co/public/semanto/example-inc/facts.jsonld
Public keys: https://api.trooth.co/public/semanto/example-inc/keys.json
```

Product data for Shopify goes through the app in `adapters/commerce-platforms/shopify/`.
