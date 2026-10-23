# Semanto by Trooth for Shopify: App Store submission checklist

Every Shopify App Store requirement (shopify.dev, "App Store requirements", read 23 October 2026) and where the app meets it. Category-specific sections that do not apply (payments, purchase options, product sourcing, checkout, sales channels, post-purchase, mobile app builders, donations, blockchain) are listed as not applicable at the end. The Built for Shopify criteria worth meeting follow.

## 1. Policy

| Req. | Requirement | How the app meets it |
| --- | --- | --- |
| 1.1.1 | Session tokens, no third-party cookies or local storage | Token exchange with the App Bridge session token (`app/shopify.server.ts`); the app sets no cookie and uses no browser storage. |
| 1.1.2 | Shopify checkout only | The app does not touch checkout. |
| 1.1.3 | Themes only through the Theme Store | The app installs no theme; it uses a theme app extension. |
| 1.1.4 | Factual information only | Screens state what happened (connected, products sent, Trooth's receipt). Copy follows Trooth's house rules: no figure Trooth did not measure. |
| 1.1.5 | Unique app | Trooth's only Shopify app. |
| 1.1.6 | Single-merchant storefronts | Not a marketplace. |
| 1.1.7 to 1.1.16 | Payments, POS, buyer charges, shipping, browser extensions, desktop apps, product duplication, agencies, refunds, lending | Not applicable: the app does none of these. It runs in the browser inside the admin (1.1.12). It sends only the merchant's own product data to the merchant's own Trooth company (1.1.13). |
| 1.2.1 | All charges through Shopify App Pricing or the Billing API | The app makes no charge, in Shopify or elsewhere: it is free, shows no plan, upsell or payment link, and none of its features is gated behind a payment. Semanto Basic, the Trooth tier that needs only a proven domain, is free (`src/basic/tier.ts`), and the repository states no Semanto price. The Billing API is therefore not used. If Trooth ever charges for anything this app does, that charge will be added through Shopify Managed Pricing before it ships, per 1.2.1 and Shopify's guidance that App Store merchants must have a Shopify-billed path. |
| 1.2.2, 1.2.3 | Billing implemented correctly; plan changes without support | Not applicable: no charges. |
| 1.3.1 | No review incentives | The app never asks for a review. |

## 2. Functionality

| Req. | Requirement | How the app meets it |
| --- | --- | --- |
| 2.1.1 to 2.1.3 | No UI bugs or web errors blocking review; operable through a UI | Every screen has loading, empty, error and success states; errors are plain sentences beside the action (`app/lib/http.server.ts`). `test/e2e.test.ts` drives install to uninstall through the real loaders and actions. |
| 2.1.4 | Synchronized data accurate and consistent | Products are mapped from the Admin API values unchanged (`app/lib/mapping.ts`); updates are sent on every product webhook when what Trooth reads changed; removed products are sent once as discontinued; Sync now re-reads everything. |
| 2.2.1 | Uses Shopify APIs | Admin GraphQL, webhooks, bulk operations, App Bridge, theme app extensions. |
| 2.2.2 | Off-platform features integrated in the admin | Connect, sync status, embed state, Sync now and Disconnect are all in the embedded app. The only step outside is the one approval on trooth.co, which must happen where the Trooth account is. |
| 2.2.3 | Latest App Bridge, loaded first | `AppProvider` loads `https://cdn.shopify.com/shopifycloud/app-bridge.js` before other scripts. |
| 2.2.4 | GraphQL Admin API | GraphQL only (`app/lib/shopify-admin.ts`); no REST call. |
| 2.2.5 to 2.2.9 | Admin, Sidekick extensions, Max modal | Not applicable: none used. |
| 2.3.1 | Install only from Shopify surfaces; no myshopify domain typed | Managed installation from the App Store; `/` without a shop sends the merchant to their admin and offers no domain field (`app/routes/_index.tsx`). |
| 2.3.2 | Authenticate immediately after install | Managed installation plus token exchange: the first load is authenticated before any screen renders. |
| 2.3.3 | Redirect to the app UI after accepting permissions | Shopify opens the embedded app at `application_url` after install. |
| 2.3.4 | Require auth on reinstall | Uninstall deletes the shop's sessions; reinstall goes through managed installation again. |

## 3. Security

| Req. | Requirement | How the app meets it |
| --- | --- | --- |
| 3.1.1 | Valid TLS | Cloudflare custom domain `shopify.trooth.co` with Cloudflare's certificate. |
| 3.2.1 to 3.2.5 | Justify protected scopes | None requested; the only scope is `read_products` (justified in app-configuration.md). |
| (automated check) | Compliance webhooks provided and checked with HMAC | Declared in `shopify.app.toml`; 401 on a bad HMAC; `test/webhooks.test.ts` and `test/e2e.test.ts`. |

## 4. App Store listing

| Req. | Requirement | How the app meets it |
| --- | --- | --- |
| 4.1.1, 4.1.2 | Same, unique name | "Semanto by Trooth" in the Dev Dashboard, the TOML and the listing. |
| 4.2.1 to 4.2.3 | Pricing complete and only in the pricing section | "Free to install" in the pricing section only; no pricing in images or the icon. |
| 4.3.1 | Say if the Online Store channel is needed | Listed: needed for the app embed. |
| 4.3.2 | Only fully supported languages | English. |
| 4.3.3, 4.3.4 | No stats or unsubstantiated claims in text or images | listing-copy.md and screenshots.md contain no figures and no promised outcome; sample catalog names read as samples. |
| 4.3.5 | Accurate tags | Structured data, product data, AI search, SEO. |
| 4.3.6, 4.3.7 | No reviews or testimonials | None. |
| 4.3.8 | Geographic or API requirements | Needs a Trooth account (free to create at the approval step); no geographic limit. |
| 4.4.1 | Subtitle states value without keyword stuffing | "A signed copy of your products that AI tools can check". |
| 4.4.2 | Details explain functionality | listing-copy.md, Details. |
| 4.4.3 to 4.4.5 | No trademark misuse; real UI; unique images | screenshots.md: six distinct captures of the real screens, cropped to the app frame. |
| 4.5.1, 4.5.2 | Sales channel configuration | Not a sales channel; no channel configuration. |
| 4.5.3 | Demo screencast | listing-copy.md, demo screencast script. |
| 4.5.4, 4.5.5 | Test credentials with full access | A Trooth review account with a company ready, entered in the submission form; numbered testing instructions in listing-copy.md. |
| 4.5.6 | Emergency developer contact | Set in Partner Dashboard settings (app-configuration.md). |

## 5.1 Online store (applies)

| Req. | Requirement | How the app meets it |
| --- | --- | --- |
| 5.1.1 | Theme changes only through theme app extensions | The head tags come from the app embed block; the app has no themes scope and edits no theme file. |
| 5.1.2 | No errors in the theme editor or storefront | The block outputs nothing until the store is connected, and only two tags after; `test/config.test.ts` checks the schema and limits. |
| 5.1.3 | Onboarding instructions for app embeds, with a deep link | The Turn on the app embed step: numbered instructions, the `activateAppId` deep link, the status read back with App Bridge. |
| 5.1.4 | App name branding in storefront components | The embed is named "Semanto by Trooth" in the theme editor; it shows nothing to shoppers. |
| 5.1.5 | Return collected customer data to the admin | Not applicable: the embed collects nothing. |

## 5.2 to 5.11: not applicable

Payments, payment facilitators, purchase options, product sourcing, checkout customization, sales channels, post-purchase, mobile app builders, donations and blockchain: the app is none of these.

## Built for Shopify criteria worth meeting

| Criterion | How |
| --- | --- |
| 2.1.1 to 2.1.3 Admin web vitals (LCP 2.5 s, CLS 0.1, INP 200 ms) | Server-rendered on a Cloudflare Worker near the merchant; the screens load no image, font or library beyond Shopify's own; layout reserves space for status (spinners and badges inline). Measured after launch from Shopify's report. |
| 2.2.1 Storefront impact under 10 Lighthouse points | The embed adds one link and one non-executing JSON-LD script tag; no JavaScript or CSS on the storefront. |
| 3.1.1 Embedded, latest App Bridge, ID token auth | Yes. |
| 3.1.2 Primary workflows in the admin | Yes; only the approval is on trooth.co. |
| 3.1.4 Home page with key status | The home page after setup shows connection, embed and last sync. |
| 3.1.5 Third-party connection managed in the app | Settings: connection state, Disconnect, Sync now. |
| 3.2.1, 3.2.2 Theme app extensions, no Asset API writes | Yes. |
| 4.1.1 Admin patterns, Polaris | Polaris web components only; no stylesheet of our own. |
| 4.1.4 s-app-nav | Setup and Settings. |
| 4.1.6 Modals used correctly | Disconnect confirmation in `s-modal` with primary and secondary actions. |
| 4.2.2 Onboarding that leads to completion | The five-step setup guide; it gives way to the status home page when done. |
| 4.2.4 Errors red, specific, near the field | Critical banners beside the action that failed, with the reason in plain words. |
| 4.3.1 No guaranteed outcomes | None in copy. |
| 4.3.2 No pressure tactics | None. |
| 4.3.6 Promotional content dismissible | The only banner after setup is the dismissible success notice. |
