# Semanto plugin for WordPress

A complete plugin, plain PHP, no Composer. PHP 8.1 or later, WordPress 6.0 or later, WooCommerce 8.0 or later for the product part.

## Install

Zip the `trooth-semanto` folder and upload it under Plugins, Add New, Upload Plugin, or:

```
cd adapters/wordpress-plugin
zip -r trooth-semanto.zip trooth-semanto
wp plugin install trooth-semanto.zip --activate
wp option update trooth_semanto_trooth_id your-trooth-id
```

Then Settings, Trooth Semanto: enter the Trooth ID, pick the mode, save.

## What it does, file by file

| File | Does |
| --- | --- |
| `trooth-semanto.php` | Plugin header, loads the classes, reads the three settings, activation and deactivation |
| `includes/class-trooth-semanto-negotiate.php` | The decision: Accept header and path suffix, same algorithm as `adapters/shared`. Pure PHP, no WordPress calls |
| `includes/class-trooth-semanto-client.php` | `wp_remote_get` to the API, transients keyed by URL with the ETag, `If-None-Match` on refresh, 304 keeps the stored bytes |
| `includes/class-trooth-semanto-serve.php` | `template_redirect` at priority 0: prints the API's bytes and headers, or steps aside; `send_headers` adds `Trooth-Semanto-Version` and `Link` to HTML; stops the canonical redirect from touching `.md` paths |
| `includes/class-trooth-semanto-head.php` | `wp_head`: `<link rel="alternate" type="text/markdown">`, `<link rel="https://trooth.co/rel/semanto">`, and the JSON-LD facts block from the API |
| `includes/class-trooth-semanto-signer.php` | Ed25519 key made with sodium on activation; RFC 9421 signatures with Content-Digest for POSTs to Trooth |
| `includes/class-trooth-semanto-woocommerce.php` | Product and variation hooks, debounced through WP-Cron, build the catalog document, sign it, POST it |
| `includes/class-trooth-semanto-settings.php` | Settings page: Trooth ID, mode, API address, connection check, public key to paste, buttons |
| `uninstall.php` | Removes every option, the key and every transient |
| `readme.txt` | WordPress.org format |

## The WooCommerce connector endpoint

```
POST {TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog
Content-Type: application/json
Content-Digest: sha-256=:<base64 of the SHA-256 of the body>:
Signature-Input: sig1=("@method" "@target-uri" "content-digest" "content-type");created=<unix seconds>;expires=<unix seconds>;keyid="<RFC 7638 thumbprint>";alg="ed25519";tag="trooth-connector"
Signature: sig1=:<base64 Ed25519 signature>:
```

Body:

```json
{
  "source": "woocommerce",
  "site": "https://acme.com/",
  "trooth_id": "acme-inc",
  "currency": "USD",
  "generated_at": "2026-10-22T12:00:00Z",
  "plugin": "trooth-semanto/0.1.0",
  "products": [
    {
      "id": "123", "type": "variable", "name": "Example widget", "url": "https://acme.com/product/example-widget/",
      "sku": "WID-1", "gtin": "00012345678905", "price": "19.00", "regular_price": "19.00", "sale_price": null,
      "stock_status": "instock", "stock": 40, "modified_at": "2026-10-21T08:00:00Z",
      "variants": [
        { "id": "124", "sku": "WID-1-RED", "gtin": "00012345678912", "price": "19.00", "stock_status": "instock", "stock": 15, "attributes": { "pa_color": "red" }, "url": "https://acme.com/product/example-widget/?attribute_pa_color=red" }
      ]
    }
  ]
}
```

(The values above are made up to show the shape.) The GTIN is read from WooCommerce's `_global_unique_id` field (the "GTIN, UPC, EAN or ISBN" box, WooCommerce 9.2 and later). The API side of this endpoint is built elsewhere; it verifies the signature with the public JWK the owner pasted into the dashboard, and answers 202.

When it sends: on `woocommerce_new_product`, `woocommerce_update_product`, the variation equivalents, and the stock hooks, one send at most a minute later, whole catalog each time. Also on the "Send products now" button.

## Notes for hosts

- The plugin answers `/.well-known/trooth.semanto` only if the web server passes that path to WordPress. Apache with the standard WordPress `.htaccess` does; nginx with `try_files $uri $uri/ /index.php?$args` does. Some managed hosts intercept `/.well-known/`; the signed copy is still on the Trooth Network and the `Link` header names it.
- Full-page caches (Varnish, host caches) must vary on `Accept` for the plugin's answers to differ from HTML. The plugin sends `Vary: Accept` on every answer; a cache that ignores it will serve markdown to browsers or HTML to agents. Most managed hosts honour it; ask yours.
- The transients hold at most 1 MB per page; larger answers are passed through without being stored.
