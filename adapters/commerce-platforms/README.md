# Commerce platform connectors

Product and variant data (SKU, GTIN, price, stock status) reaches Trooth through a signed POST, so the commerce records in a company's Semanto are built from what the store itself says. Every connector sends the same document to the same endpoint:

```
POST {TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog
```

signed per RFC 9421 with an RFC 9530 Content-Digest (`adapters/shared/sign-request.mjs`), Ed25519, `tag="trooth-connector"`. The API side is built elsewhere; it looks the key id up among the connector keys pasted into the dashboard and answers 202. The document shape is in `adapters/wordpress-plugin/README.md`.

| Platform | How | Folder |
| --- | --- | --- |
| Shopify | A custom app with `read_products` and `read_inventory`; the script reads the Admin GraphQL API and posts | `shopify/` |
| BigCommerce | A store API account with Products read-only; the script reads the Catalog API v3 and posts | `bigcommerce/` |
| Salesforce Commerce (B2C) | An OCAPI client id with the Shop API allowed; the script reads `product_search` and `products/{id}` and posts | `salesforce-commerce/` |
| WooCommerce | The WordPress plugin does it from inside the store | `woocommerce/` (points at the plugin) |

## First run, any script

```
cd adapters/commerce-platforms/shopify
SHOPIFY_SHOP=acme.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_xxx TROOTH_ID=acme-inc node shopify-sync.mjs --dry-run
```

`--dry-run` prints the document and sends nothing. The first real run makes `trooth-connector-key.json` next to the script (private; keep it out of git) and prints the public key to paste into the Trooth dashboard under Delivery, Connectors. After that, run the script on a schedule (hourly is plenty; Trooth builds a fresh signed offer only when a value changed) or from the platform's product webhooks.

Environment variables:

| Script | Variables |
| --- | --- |
| all | `TROOTH_ID`, `TROOTH_API_BASE` (default `https://api.trooth.co`), `TROOTH_CONNECTOR_KEY_FILE` (default `./trooth-connector-key.json`) |
| `shopify-sync.mjs` | `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION` (default `2025-10`) |
| `bigcommerce-sync.mjs` | `BC_STORE_HASH`, `BC_ACCESS_TOKEN` |
| `sfcc-sync.mjs` | `SFCC_HOST`, `SFCC_SITE_ID`, `SFCC_CLIENT_ID`, `SFCC_OCAPI_VERSION` (default `v24_5`), `SFCC_STOREFRONT_URL`, `SFCC_CURRENCY` |

## Shopify: the app

1. Shopify admin, Settings, Apps and sales channels, Develop apps, Create an app. Configure Admin API scopes `read_products` and `read_inventory`. Install the app and copy the Admin API access token.
2. Run `shopify-sync.mjs` as above. The GraphQL query it sends is exported as `PRODUCTS_QUERY` in the file (products with status active, 50 per page, variants with sku, barcode, price, compareAtPrice, availableForSale, inventoryQuantity, selectedOptions).
3. For near-live updates, subscribe the same app to the `products/update` and `inventory_levels/update` webhooks and run the script from the webhook handler, debounced to one run a minute.

Shopify allows no custom root paths for apps, so the signed copy itself is served by Trooth; add the head tags and the `llms.txt` and `agents.md` templates from `adapters/head-tag/`.

## BigCommerce

Settings, Store-level API accounts, Create API account, scopes Products read-only and Information and settings read-only. The script pages through `/v3/catalog/products?include=variants&is_visible=true` 250 at a time and reads the store URL and currency from `/v2/store`. GTIN comes from the product and variant `gtin`, `upc` or `ean` fields.

## Salesforce Commerce (B2C)

Business Manager, Administration, Site Development, Open Commerce API Settings: allow the Shop API resources `/product_search` and `/products/*` for your client id. The script searches all products, then reads each with `expand=prices,availability,variations`, and each variant with `expand=prices,availability`. On large catalogs that is many calls; run it nightly or restrict the search with a category refinement (`refine=cgid=<category id>`).
