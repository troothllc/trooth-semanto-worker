=== Trooth Semanto ===
Contributors: trooth
Tags: markdown, json-ld, agents, llms.txt, woocommerce
Requires at least: 6.0
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 0.1.0
License: LicenseRef-Trooth-Proprietary
License URI: https://trooth.co/legal/adapters-license

Your whole public website in one signed file, served from your own domain to people and agents.

== Description ==

Semanto by Trooth keeps a signed copy of your public website: every page as markdown, every fact tied to its source, signed by you and witnessed by Trooth. This plugin serves that copy from your own domain.

What it does:

* When a reader asks for a page with `Accept: text/markdown` (or a path ending in `.md`), it answers with the signed markdown of that page, byte for byte, with the signature headers.
* When a reader asks for `application/ld+json` (or a path ending in `.jsonld`), it answers with your signed facts file.
* It serves `/.well-known/trooth.semanto`, `/.well-known/trooth-keys.json`, `/llms.txt`, `/llms-full.txt` and `/sitemap.md`.
* It adds a `<link rel="alternate" type="text/markdown">` and the facts block (JSON-LD) to your pages' head.
* With WooCommerce, it sends your product catalog (name, SKU, GTIN, price, stock status, per variation) to Trooth, signed with a key made on your site, so your product records are built from what your store says. Nothing about customers or orders is sent.

The decision is made on the Accept header and the path. The plugin never looks at who the reader is.

Everything else on your site works as before.

== Installation ==

1. Upload the `trooth-semanto` folder to `/wp-content/plugins/`, or install the zip from Plugins, Add New, Upload.
2. Activate the plugin.
3. Go to Settings, Trooth Semanto, and enter your Trooth ID (from your Trooth dashboard). Save.
4. Check from outside: `curl -sI https://yoursite.com/.well-known/trooth.semanto` shows a `Signature` header.
5. With WooCommerce: copy the public key from the settings page into your Trooth dashboard under Delivery, Connectors, WooCommerce, then press "Send products now".

== Frequently Asked Questions ==

= Does this change what people see in a browser? =

No. Browsers ask for HTML and get your site as before. Only readers that ask for markdown or JSON-LD get the signed copy.

= What is sent to Trooth? =

Requests for the signed copy are fetched from Trooth and kept in a short cache. With WooCommerce, the product catalog is sent when a product changes. No customer or order data is sent.

= My host blocks /.well-known =

Some hosts serve `/.well-known/` themselves. The signed copy also lives on the Trooth Network, and your `_trooth` DNS record points at it, so agents find it either way. Ask your host to pass `/.well-known/trooth.semanto` and `/.well-known/trooth-keys.json` to WordPress.

= Which modes are there? =

`semanto_only` (recommended) answers every markdown and JSON-LD request from the signed copy. `semanto_then_cloudflare_for_unsigned` answers only the pages in your current Semanto and leaves the rest to your site or to Cloudflare. `proof_only` serves only the two `/.well-known` files and adds the headers to your HTML.

== Changelog ==

= 0.1.0 =
* First release: markdown and JSON-LD on request, well-known and llms files, head links and facts block, WooCommerce catalog send.
