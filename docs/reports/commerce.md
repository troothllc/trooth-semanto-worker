# Commerce layer report (src/commerce)

Date: 2026-10-22. Area: `src/commerce`, `test/commerce.test.ts`, `test/fixtures/commerce/`.

## Why this exists

Shoppers blame the brand when an assistant gives wrong product information, price is the field they most want right, availability lookups fail often, and variant confusion is the most common error. Blended feeds without provenance produce stale prices. Semanto signs products at the variant level, signs every offer with an explicit age, and generates every feed from the same signed record, so a mismatch anywhere can be named field by field.

## What was built, file by file

### `src/commerce/product-record.ts` (requirement 19)
- `ProductRecord`: `object: "semanto.product"`, smk_ `id`, `product_id`, `variant_id?`, `gtin?`, `sku`, `mpn?`, `brand`, `name`, `description`, `attributes[]`, `ingredients?[]` with synonyms and INCI, `regulatory` (hazard, consumer_notice with an optional `consumer_notice_type` of prop_65, safety_warning or legal_disclaimer, age_restriction, country_restrictions), `media[]` with hashes, `url`, `parent_product_id?`, `variant_axes` (size, color, formulation, edition), `provenance: "declared"`, `evidence`, `not_before`, `not_after?`.
- GS1 check digit: `gtinCheckDigit`, `isValidGtin` for GTIN-8, 12, 13 and 14, `normalizeGtin` (left pad to 14, the GS1 rule for the same item).
- `productRecordId`: `smk_` content address over the canonical record without `id` and `signature`.
- `signProductRecord` (JWS typ `product-record`, nbf and exp from the record's window) and `verifyProductRecord` (type, signature, validation, id recomputed).
- `resolveVariant(records, query)`: exact match on every given field; returns `{ kind: "one" }`, `{ kind: "ambiguous", candidates, axes_to_ask }` or `{ kind: "none" }`. Never a guess.

### `src/commerce/synonyms.ts` (requirement 19 and 23)
- `SUBSTANCE_TABLE`: 48 groups (isopropyl alcohol = 2-propanol = isopropanol; sodium chloride = salt; tocopherol = vitamin E; water = aqua; glycerin = glycerol; and so on), each with its INCI name where one exists.
- `SPELLING_TABLE`: spelling variants only (colour/color, sulphate/sulfate, grey/gray).
- `normalizeName`, `normalizeInci`, `lookupSubstance`, `synonymsOf`.
- `sameSubstance(a, b)`: same only via exact normalized match, a spelling variant, or the table. No distance measure anywhere. `sameAttributeName`, `sameAttributeValue`, `listContains`.

### `src/commerce/offers.ts` (requirement 20)
- `Offer`: `object: "semanto.offer"`, smo_ `id`, `sku`, `variant_id?`, `price { amount (integer minor units), currency }`, `availability` (in_stock, out_of_stock, preorder, backorder, discontinued), `inventory_quantity?`, `as_of`, `not_after`, `seller { domain, trooth_id }`, `url`, `shipping?[]`, `return_policy_url?`.
- `OfferPolicy { validity_minutes: 15, fresh_minutes: 5 }`, settable per company through `offerPolicy()` and the store.
- `buildOffer`, `offerId`, `signOffer` (JWS typ `signed-offer`, nbf = as_of, exp = not_after), `verifyOffer` (with `allowExpired` for history), `reSignOffer` (new as_of, new id, new signature on any change).
- `stateOf(offer, now)`: fresh, stale or expired by the clock.
- Endpoint shapes: `offerFeed` (every current offer) and `offerAnswer` (one sku). Both always carry `as_of`, `not_after`, `state` and `age_seconds`.
- Money helpers: `formatMinor`, `parseMinor`, `currencyExponent` (ISO 4217 exponents for 0 and 3 decimal currencies).

### `src/commerce/feeds.ts` (requirement 21, outputs used by 26)
- `joinLines`: newest offer per sku and variant joined to its record; a record with no offer is listed in `skipped`, never published with an invented price.
- Google Merchant Center: `merchantCenterTsv` and `merchantCenterJson` with the attribute names id, title, description, link, image_link, price "12.34 USD", availability, gtin, brand, mpn, item_group_id, color, size, consumer_notice ("prop_65:text"), native_commerce ("yes" or "no"), merchant_item_id, condition. `merchantCenterContentApi` maps the same item to the Content API v2.1 product resource (offerId, imageLink, price {value, currency}, itemGroupId, sizes, consumerNotices, customAttributes). `parseMerchantCenterTsv` reads a TSV back.
- OpenAI ACP: `acpFeed`, a JSON array of items with id, title, description, link, price (decimal string), currency, availability, inventory_quantity, gtin, brand, mpn, item_group_id, image_link, condition, shipping, return_policy, seller_name, and a `provenance { signed_record_url, record_hash, as_of, not_after }` block on every item.
- Google UCP: `ucpManifest(company)` for `/.well-known/ucp` listing the shopping service, the catalog, product_discovery and checkout capabilities (checkout endpoints are configurable values, published as null when the merchant has not given them), payment handlers, and a `co.trooth.semanto` extension pointing at the signed catalog, products, offers and the JWK Set. `ucpCatalog` is the catalog file with minor-unit prices, as_of, not_after and a `semanto` block naming the record id, record hash and offer id.
- `generateFeeds(source, now)` produces all of them from one source.
- `parityCheck(source, kind, feed)` reads any feed back (TSV or JSON) and returns `Drift[]` in the monitor's shape `{ key, signed_value, feed_value, kind }`, with kinds price, availability, identity, text, link, variant, regulatory, terms, provenance, other, missing and extra.

### `src/commerce/sellers.ts` (requirement 22)
- `SellerAttestation`: `object: "semanto.seller_attestation"`, sms_ `id`, `brand_trooth_id`, `seller_domain`, `seller_trooth_id?`, `scope` ("all_products" or `{ skus }`), `not_before`, `not_after`, `provenance: "attested"`, `evidence`. `signSellerAttestation` (JWS typ `seller-attestation`), `verifySellerAttestation`.
- `officialSpecPointer`: the brand's product record (id, url, hash) is the official specification.
- `isAuthorized(brand, seller_domain, sku, now)`: returns exactly one of authorized, not_listed, expired, withdrawn, with the attestation id it rests on. A future-dated attestation is not_listed until its not_before.
- `compareListing(official, listing)`: name, brand, gtin (14-digit comparison), mpn, description, url, each variant axis, each official attribute (names matched through the spelling table), each ingredient (through the synonym table, never similarity), and the consumer notice. Each field is matches, mismatch or not_in_listing.

### `src/commerce/nested.ts` (requirement 23)
- `MarketplaceCatalog`: `object: "semanto.catalog"`, `marketplace_trooth_id`, `assembled_at`, `listings[{ seller_trooth_id, offer_jws, product_record_jws?, listed_price? }]`. `signCatalog` (JWS typ `marketplace-catalog`).
- `verifyCatalog(jws, keys, opts)`: the outer marketplace signature and every inner seller signature are checked independently, with keys resolved per seller so a key that belongs to another company does not verify a seller's offer. Each listing reports `failed_layer` of marketplace, seller_offer or seller_record (or null), and `price` as matches, mismatch, not_listed or unchecked. A marketplace price that differs from the seller's signed offer is a price mismatch, not a signature failure. An outer failure does not stop the inner checks.

### `src/commerce/recalls.ts` (requirement 24)
- `RecallNotice`: `object: "semanto.recall"`, smn_ `id`, `skus?` and or `gtins?` (GTINs check-digit validated), `lots?`, `issued_at`, `authority? { name, url, reference? }`, `action` (stop_sale, stop_use, return, repair), `statement`, `url`, `closed_at?`. `signRecall` (JWS typ `recall-notice`, nbf = issued_at, no exp so it stays checkable), `verifyRecall`.
- `recallChangeEntry(trooth_id, signed)`: the `semanto.change` entry a poller of company_changes sees, with kind recall_issued or recall_closed, the notice fields and the JWS.
- `affected(offer, notices, ctx)`: matches by sku or by GTIN (from the record), respects lots when the seller gives one, and is cautious (affected, `lot_unknown: true`) when a lot-scoped notice meets an offer without a lot. `availabilityAnswer` returns "recalled" over any stock value. `withRecallStatus` overlays the signed offer without changing it.

### `src/commerce/ports.ts`
`CommerceStore` interface (company, offer policy, records, offers, attestations, recalls, puts) and `InMemoryCommerceStore` for tests. The D1 adapter against `semanto_products`, `semanto_offers`, `semanto_sellers` and `semanto_recalls` belongs in `src/db` and is not written here.

### `src/commerce/routes.ts`
Pure handlers returning `{ status, headers, body }`: `productsResponse`, `productResponse`, `offersResponse`, `offerResponse` (Cache-Control max-age equals the seconds left to not_after; carries availability_answer and recall ids), `feedResponse` (merchant-center as TSV or JSON, acp, ucp; the kind comes from the path, never from User-Agent), `ucpManifestResponse`. Errors are RFC 9457 problems with code, retryable, next_action and terminal, and `problemMarkdown` gives the markdown form.

### `src/commerce/index.ts`
Barrel export.

## Requirement numbers covered

19 (variant-level product records and the resolver), 20 (fresh signed offers), 21 (feed parity across Merchant Center, ACP and UCP), 22 (authorized sellers and listing comparison), 23 (nested marketplace signatures), 24 (recall notices). The feed generators and `parityCheck` are the outputs requirement 26 (the monitor) reads.

## Change to src/core

One line added to `JWS_TYPES` in `src/core/jws.ts`, because every signed statement must carry a registered typ and the marketplace envelope had none:

```diff
   recall: "https://trooth.co/types/recall-notice",
+  marketplaceCatalog: "https://trooth.co/types/marketplace-catalog",
```

## Stubbed or needing a founder step

- Key custody: the tests generate keys in memory. Production signing uses each company's key from `semanto_keys` and the JWK Set at `/.well-known/trooth-keys.json`; the key resolver passed to every verifier is the caller's.
- The D1 implementation of `CommerceStore` is not here (src/db owns SQL).
- Merchant Center upload, ACP feed registration with OpenAI and UCP registration with Google are founder steps with each platform's merchant account; this module produces the files and the manifest. The checkout endpoints in the UCP manifest are published as null until a merchant supplies them.
- `consumer_notice` text is the brand's own wording; Trooth does not write regulatory text.
- The recall change entry is a shape; wiring it into the company_changes feed is the monitor's or serve's job.

## How to run

```
npx vitest run test/commerce.test.ts
npx tsc --noEmit
```

49 tests: GTIN check digits (012345678905, 4006381333931, 96385074, 10614141000415 accepted; wrong digits refused); records sign and verify, identical content gives the identical id; the resolver returns one, an explicit ambiguity with axes to ask, or none; synonyms match through the table ("isopropyl alcohol" equals "2-propanol") and not by similarity ("sodium chloride" does not equal "sodium chlorite"); offers go fresh, stale, expired by the clock; all feeds generate from one record and the parity check reports a changed price in each; the four seller states; nested verification names the failing layer and reports a price mismatch; a recall overrides availability; the route handlers serve as_of and not_after and RFC 9457 problems.
