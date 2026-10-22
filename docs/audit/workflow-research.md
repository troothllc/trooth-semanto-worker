# Semanto setup workflow research

Semanto by Trooth only. Research date: 22 October 2026. Every rating below was seen on that date at the URL given. Where a rating could not be found, the table says so; nothing is estimated.

Contents

1. What exists in the repo today, and the gaps this research found
2. Ratings, ranked by evidence of user approval
3. Published onboarding benchmarks
4. Top-rated flow per Semanto step: exact click paths, credited patterns, complaints
5. Recommended Semanto click path, nine steps, with states and timings
6. Changes needed to align the repo with the path

---

## 1. What exists today

| Piece | What it does now | Gap against the nine customer steps |
| --- | --- | --- |
| `src/basic/tier.ts` | State machine `claim -> domain_proved -> basic_built -> upgraded`. Proof by DNS TXT at `_trooth.<domain>` with value `v=trooth1; claim=<token>`, or the file `/.well-known/trooth-claim.txt`. `SETUP_CHECKLIST` has six steps summing to 600 seconds: type domain 30, publish token 240, Trooth checks 60, read and build 180, paste head tag 60, first report 30. `measureSetup` times steps from timestamps. | No sign-in step, no review-and-confirm, no sign, no test. The build refuses to start until the domain is proved, so the 180-second read sits on the critical path. The head tag and first report are counted inside Basic, while the brief says Basic stops after step 4. |
| `flows-blueprint/src/lib/domain-connect.ts` | One Domain Connect template (`trooth.co.domainclaim`) writing two TXT records: `_trooth-challenge` = `trooth-domain-challenge=<48 hex>` and `_trooth` = `v=trooth1; id=<tid>; key=<fp>`. Signed synchronous apply link. `ONBOARDED` is an empty set, so no customer sees the one-click button today. | The proof record format differs from `tier.ts` (`_trooth` with `claim=` there, `_trooth-challenge` here). One of the two must win. Seven DNS providers already run Domain Connect live (section 4, step 3), Cloudflare and GoDaddy among them. |
| `flows-blueprint/src/lib/dns-diagnosis.ts` | Ten proof states with one plain sentence and one fix each: `not_started`, `looking`, `doubled_name`, `wrong_value`, `old_value`, `proven`, `recheck_missing`, `lapsed`, `timed_out` (72 hours), `claimed_elsewhere`. Modelled on Resend and Vercel. | Already matches the best-rated pattern (plain error with the fix). Keep. |
| `flows-blueprint/src/components/semanto/semanto-setup-tracker.tsx` | Six-step tracker (Prove your domain, Witness your systems, Complete your Trust Profile, Build your Semanto, Sign it, Serve it), live poll with backoff 4 s to 60 s, progress bar with real counts, "You can close this page", email only when something needs the owner, developer handoff. | Steps do not match the nine customer steps (witness and Trust Profile are not in the Semanto customer path). The file header calls the screen "Trooth Live Verification Pending"; replace with "Setting up Semanto" so no screen pairs "verification" with the company. |
| `src/serve/detect.ts` | Detects Cloudflare, Vercel, Netlify, Fastly, Akamai, Gcore, WordPress, nginx, Apache from headers. | Shopify, Webflow, Squarespace and Wix fall to `unknown`, yet those four are where per-host instructions matter most for a small business. |
| `src/settings/delivery.ts` | `HostKind` lists the same hosts plus `head_tag`. Plain-language validation messages. | Add `shopify`, `webflow`, `squarespace`, `wix` so the install screen can pick the guide on its own. |
| `adapters/README.md` | Adapter per host; head-tag fallback for Shopify, Webflow, Squarespace, Wix. | Matches the platform limits found in this research (Webflow head code on paid plans, Squarespace code injection on Core and above). |
| `web/semanto/*.tsx` | Delivery settings, key binding, read receipts, gap report, consistency monitor, Basic upgrade card. Labels are already plain ("Left it out", "Not found", "Matches what you signed"). | The gap report labels "Found", "Left it out" are the right words for the coverage receipt. |

---

## 2. Ratings, ranked by evidence

All G2 numbers are G2's sub-ratings out of 10, read from G2 comparison pages on 22 October 2026. G2 product review pages do not print the sub-ratings in their text; the comparison pages do. Review counts are G2's own. Small counts are flagged.

### 2.1 G2 Ease of Setup and Ease of Use

| Product (Semanto step it informs) | Ease of Setup | Ease of Use | Ease of Admin | Reviews | Source |
| --- | --- | --- | --- | --- | --- |
| Peec AI (9, monitoring) | 9.7 | 9.6 | 9.8 | 21 (small) | https://www.g2.com/compare/peec-ai-vs-profound |
| Vercel (7, install) | 9.4 (9.457) | 9.4 (9.472) | 9.3 | 87 to 88 | https://www.g2.com/compare/netlify-vs-vercel and https://www.g2.com/compare/cloudflare-application-security-and-performance-vs-vercel |
| Postmark (3, domain records) | 9.3 (9.316) | 9.2 | 9.7 | 32 | https://www.g2.com/compare/activecampaign-postmark-vs-resend |
| Rank Math (WordPress plugin first run) | 9.3 | 9.4 | 9.3 | 101 | https://www.g2.com/compare/rank-math-vs-seopress |
| Fathom Analytics (7, script on any host) | 9.2 (9.28) | 9.6 | not enough data | 21 (small) | https://www.g2.com/compare/fathom-analytics-vs-plausible-analytics |
| Google Search Console (3 and 4) | 9.2 | 9.1 | 9.3 | 513 | https://www.g2.com/compare/bing-webmaster-tools-vs-google-search-console |
| Netlify (7) | 9.2 (9.241) | 9.2 | 9.1 | not printed | https://www.g2.com/compare/netlify-vs-vercel |
| Akamai Cloud Computing (7) | 9.2 | 9.1 | 9.0 | 406 to 410 | https://www.g2.com/compare/akamai-cloud-computing-vs-cloudflare-application-security-and-performance |
| OtterlyAI (9) | 9.2 | 9.3 | 9.2 | 54 | https://www.g2.com/compare/otterlyai-vs-scrunch-ai |
| Scrunch AI (9) | 9.1 | 8.7 | 9.1 | 73 | same |
| Resend (3) | 9.0 (9.05) | 9.4 | not enough data | 9 (small) | https://www.g2.com/compare/activecampaign-postmark-vs-resend |
| Stripe Connect (save-and-resume onboarding) | 8.9 | 8.8 | 8.9 | 132 rated setup, 249 total | https://www.g2.com/compare/paypal-vs-stripe-connect |
| Wix (7) | 8.9 | 8.9 | 8.7 | 1,576 | https://www.g2.com/compare/squarespace-vs-wix |
| Cloudflare Application Security and Performance (3 and 7) | 8.8 | 8.9 | 8.9 | 714 to 801 | https://www.g2.com/compare/akamai-cloud-computing-vs-cloudflare-application-security-and-performance |
| Squarespace (7) | 8.8 | 8.8 | 8.8 | 988 | https://www.g2.com/compare/squarespace-vs-wix |
| Docusign (6, signing) | 8.6 | 9.0 | 8.4 | 2,209 | https://www.g2.com/compare/adobe-acrobat-sign-vs-docusign |
| Profound (9) | 8.6 | 8.7 | 8.8 | 1,133 | https://www.g2.com/compare/peec-ai-vs-profound |
| Adobe Acrobat Sign (6) | 8.3 | 8.7 | 8.2 | 820 | https://www.g2.com/compare/adobe-acrobat-sign-vs-docusign |
| Bing Webmaster Tools (3, contrast) | 8.4 | 8.4 | 8.5 | 42 | https://www.g2.com/compare/bing-webmaster-tools-vs-google-search-console |

Not found on G2 on 22 October 2026: Plausible Analytics (G2 shows "Not enough data" for every sub-rating, 3 reviews), Dropbox Sign (the comparison URL redirected to Adobe Acrobat Sign), Yoast SEO (the comparison URL redirected to Rank Math vs SEOPress), Let's Encrypt and Certbot (no G2 listing checked), Shopify app install (no G2 listing for the flow itself).

### 2.2 WordPress.org plugin ratings (public API, 22 October 2026)

Rating is WordPress.org's 0 to 100 value; stars are that value divided by 20.

| Plugin | Stars | Ratings | 1-star count | Active installs | Source |
| --- | --- | --- | --- | --- | --- |
| Really Simple Security | 4.9 (98) | 8,868 | 89 | 3,000,000+ | https://wordpress.org/plugins/really-simple-ssl/ |
| WPCode (Insert Headers and Footers) | 4.9 (98) | 1,910 | 43 | 3,000,000+ | https://wordpress.org/plugins/insert-headers-and-footers/ |
| Yoast SEO | 4.8 (96) | 27,821 | 846 | 10,000,000+ | https://wordpress.org/plugins/wordpress-seo/ |
| Rank Math SEO | 4.8 (96) | 7,517 | 196 | 4,000,000+ | https://wordpress.org/plugins/seo-by-rank-math/ |
| Plausible Analytics | 5.0 (100) | 29 (small) | 0 | 10,000+ | https://wordpress.org/plugins/plausible-analytics/ |
| Fathom Analytics for WP | 4.8 (96) | 25 (small) | 1 | 10,000+ | https://wordpress.org/plugins/fathom-analytics/ |
| Site Kit by Google | 4.2 (84) | 1,012 | 145 | 5,000,000+ | https://wordpress.org/plugins/google-site-kit/ |

Data from `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=<slug>`.

### 2.3 Shopify App Store (22 October 2026)

| App | Stars | Reviews | 1-star share | Source |
| --- | --- | --- | --- | --- |
| Google & YouTube | 4.5 | 5,557 | 12% (650) | https://apps.shopify.com/google |
| Yoast SEO for Shopify | 4.3 | 176 | 13% (22) | https://apps.shopify.com/yoast-seo |

### 2.4 Capterra (22 October 2026)

| Product | Overall | Ease of Use | Reviews | Source |
| --- | --- | --- | --- | --- |
| Cloudflare | 4.7 | 4.6 | 529 | https://www.capterra.com/p/155191/Cloudflare/ |
| Stripe | 4.6 | 4.5 | 3,390 | https://www.capterra.com/p/123889/Stripe/ |

Not found: Plausible on Capterra (the product URL returned 404). Trustpilot was not checked; none of the candidates' setup flows are reviewed there in a way that separates setup from billing or support.

### 2.5 What the ranking says

- The highest Ease of Setup ratings with meaningful samples go to products that do the work for the user: Vercel (9.4, picks the record type for the domain and shows the exact value), Postmark (9.3, records turn green on their own, a Verify button as backup), Google Search Console (9.2 with 513 reviews, one-click provider verification), Fathom (9.2, one script plus per-host guides).
- Cloudflare (8.8) and Squarespace (8.8) trail because their flows ask the user to understand DNS or a code panel. Search Console beats Bing Webmaster Tools by 0.8 on setup with the same job.
- Among AI-visibility tools, the small tools with guided first projects rate highest (Peec 9.7, Otterly 9.2); Profound, with the largest sample, rates 8.6 and its reviewers name a learning curve.
- On WordPress, single-purpose plugins with no wizard (WPCode 4.9, Really Simple Security 4.9) outrate the multi-screen Google wizard (Site Kit 4.2).

---

## 3. Published onboarding benchmarks

| Benchmark | Number | Source, date seen |
| --- | --- | --- |
| Userpilot Benchmark Report 2025, 547 SaaS companies | Median time to value 1 day, 12 hours, 23 minutes | https://userpilot.com/blog/time-to-value/ (22 Oct 2026) |
| Userpilot product metrics page | Checklist completion: average 19.2%, median 10.1%; fintech and insurance 24.5%. The same page also shows a 37.5% headline figure for checklist completion; the two figures conflict and Userpilot does not reconcile them | https://userpilot.com/saas-product-metrics/ (22 Oct 2026) |
| Userpilot 2024 report | Companies with activation above 50% used video, GIFs or animation in onboarding | https://userpilot.com/blog/product-metrics-benchmark-report/ (22 Oct 2026) |
| Chameleon benchmark, 550 million data points | 3-step tours 72% completion; tours launched from a checklist 67% completion; checklist users complete 5 items per session | https://www.chameleon.io/blog/effective-product-tour-metrics and https://www.chameleon.io/blog/mastering-product-tours (22 Oct 2026) |
| Appcues guidance | Healthy flows reach first value in 1 to 3 days; checklist completion under 30% signals real friction | https://www.appcues.com/blog/time-to-value and https://www.appcues.com/blog/user-onboarding-metrics-and-kpis (22 Oct 2026) |
| Peec AI quickstart | Setup "takes less than 10 minutes", first insights "within 24 hours" | https://docs.peec.ai/quickstart-guide (22 Oct 2026) |
| OtterlyAI help | First results "typically appear in a couple of minutes"; first Brand Report is created automatically during setup | https://help.otterly.ai/what-is-otterly.ai (22 Oct 2026) |
| Otterly via Semrush | Report "may take up to 5 minutes to prepare" | https://www.semrush.com/kb/1487-otterly-ai-search-monitoring (22 Oct 2026) |
| Resend domain docs | Domain "will often verify within 15 minutes"; up to 72 hours; then "Restart verification" | https://resend.com/docs/add-a-domain (22 Oct 2026) |
| Resend auto-configure (secondhand) | GoDaddy domains: "One click Automatic DNS ~2 minutes to verification". Seen only as a search snippet of a LinkedIn post by Resend's founder; the post itself could not be opened | search result for https://www.linkedin.com/posts/zenorocha_thousands-of-resend-customers-use-vercel-activity-7439683423033622528-PcZ5 (22 Oct 2026) |
| Search Console manual DNS | "It can take up to two or three days for your provider to start serving the record" | https://support.google.com/webmasters/answer/9008080 (22 Oct 2026) |
| Postmark | Verification "within 48 hours" | https://postmarkapp.com/support/article/how-do-i-verify-a-domain (22 Oct 2026) |

What this means for Semanto: the market median is a day and a half to first value; the AI-visibility leaders promise under ten minutes of setup and first results in minutes to a day. Semanto's ten-minute Basic target with the receipt as first value would beat the median by two orders of magnitude, so the target is worth defending. Fewer steps per screen keeps completion near the 72% three-step figure; nine steps must therefore be grouped into a few screens, each with one job.

---

## 4. Top-rated flow per Semanto step

Each flow below is copied from the official doc named. Labels in bold are the product's own words. Times are the product's own claims where it states one; otherwise "not stated".

### Step 1. Sign up or sign in

Leader: GitHub passkey creation, plus Shopify's rule that apps sign merchants up with their existing Shopify login.

GitHub, add a passkey (https://docs.github.com/en/authentication/authenticating-with-a-passkey/managing-your-passkeys):

1. Profile picture, **Settings**.
2. Sidebar "Access", **Password and authentication**.
3. Under "Passkeys", **Add a passkey**.
4. If asked, confirm with password or another method.
5. Under "Configure passwordless authentication", **Add passkey**.
6. The device's own passkey prompt (Touch ID, Windows Hello, phone).
7. Confirmation page, **Done**.
8. GitHub "may prompt you to register the device as a passkey during sign-in", so most people never visit the settings page.

Shopify App Store requirement 3.1.3 "Enable seamless sign up based on Shopify credentials" and 2.3.1 "Your app must not request the manual entry of a myshopify.com URL or a shop's domain" (https://shopify.dev/docs/apps/launch/built-for-shopify/requirements, https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).

Credited patterns: offer the passkey during sign-in, not as a separate chore; never ask for something the platform already knows.

Complaints to avoid: a Google & YouTube 1-star review (12 October 2026): "Sign In and google doesn't recognise any of it. An endless loop of 'passkey'." (https://apps.shopify.com/google/reviews?ratings%5B%5D=1). Always give a second way in (email link) when the passkey prompt fails or is dismissed.

Prior Trooth finding (Project doc `trooth-competitive-benchmark-2026-07-26.md`): the email round-trip at signup was the top friction item; a magic link that signs the person straight in fixes it without leaking whether an account exists.

### Step 2. Name the company and its website

Leader: Plausible "Add your website details" (https://plausible.io/docs/add-website), with Vercel's www prompt and Resend's domain-claim notice.

1. After signup, the site form opens on its own.
2. Type the domain in **Domain**; Plausible tells the user to drop `https://` and `www.`.
3. Choose the time zone (Plausible); continue.
4. The next screen is the install snippet.

Vercel: "If you add an apex domain (e.g. `example.com`) to the project, Vercel will prompt you to add the `www` subdomain prefix" (https://vercel.com/docs/domains/working-with-domains/add-a-domain, last updated 16 September 2026).

Resend: "If you add a domain already used by another team, the dashboard will notify you and you can claim the domain" (https://resend.com/docs/add-a-domain).

Credited patterns: one field; accept a pasted full URL and clean it; tell the user at once if someone else holds the domain. Ratings: Fathom 9.2 Ease of Setup (small sample); Plausible 5.0 stars on WordPress.org (small sample).

Time: not stated by Plausible; one field takes under 30 seconds.

### Step 3. Prove control of the domain

Leader: Google Search Console Domain property (Ease of Setup 9.2, 513 reviews), with Resend's auto-configure and Postmark's automatic check.

Search Console (https://support.google.com/webmasters/answer/9008080):

1. Add a Domain property; the **Domain name provider** method is chosen automatically.
2. If Search Console shows the user's provider in a list: choose it, **Start verification**, sign in at the provider; "verification should occur immediately".
3. If it shows a provider that is not theirs: choose **Any DNS provider**.
4. Manual path: **Select record type** TXT (or CNAME), copy the value, add it at the DNS host with Host/Name blank or `@`, then **Verify**.
5. Errors, in Google's words: "Your verification DNS TXT record was not found", "Your verification record did not match".
6. Google tells the user to keep the DNS record at the provider for as long as the property should stay confirmed (paraphrased; Google's sentence uses the past participle of "verify", which this repository does not print).
7. Manual records can take "up to two or three days"; advice on failure: "Wait a day or two and try again."

Resend (https://resend.com/docs/add-a-domain): **Add Domain**, type the domain, choose a region, open the **Records** tab, "Copy and paste the records to avoid configuration errors", per-provider DNS guides, warning not to proxy CNAMEs through Cloudflare's orange cloud, "often verify within 15 minutes", **Restart verification** after 72 hours. A one-click **Auto configure** button opens a sign-in pop-up at the DNS provider (Cloudflare shown: dash.cloudflare.com) per a customer's help article (https://docs.boomerangme.cards/white-label/resend) and a user write-up (https://parish.cv/blog/how-i-set-up-email-on-my-custom-domain-for-free).

Postmark (https://postmarkapp.com/support/article/how-do-i-verify-a-domain): **Sender Signatures**, **DNS Settings**, add the TXT and CNAME shown; records turn green automatically, and the **Verify** button starts a manual check when a record has not turned green on its own (paraphrased from Postmark's help page). Per-provider links for 19 DNS hosts.

Domain Connect today (https://www.domainconnect.org/dns-providers/, 22 October 2026): "Implementation is Live" for IONOS, Cloudflare, Domain Chief, Glauca Digital, GoDaddy, NameSilo, Plesk, Vercel and WordPress.com. Onboarding a template:

- Cloudflare (https://developers.cloudflare.com/dns/reference/domain-connect/): fork the templates repository, add `<providerId>.<serviceId>.json`, open a pull request; after merge, email `domain-connect@cloudflare.com` with the template links, the `syncPubKeyDomain` names, an SVG logo and the default proxy status. "Cloudflare only supports the Domain Connect synchronous flow" and `syncBlock` must be `false`. The user "will only have to authenticate themselves and the necessary changes will be applied automatically."
- Vercel (https://vercel.com/docs/domains/domain-connect, updated 8 June 2026): discovery via `_domainconnect` TXT returns `domainconnect.vercel.com`; the settings call returns `urlSyncUX: https://vercel.com/domain-connect`; "Vercel shows the user which DNS records will be created and asks for permission"; signed requests required; only for domains on Vercel nameservers.

`domain-connect.ts` already sets `syncBlock: false`, `syncPubKeyDomain: "trooth.co"` and signs requests, so it meets both providers' rules as written.

Credited patterns: detect the provider and offer one button; copy button on every value; check on its own without a button, with a manual "check now" as backup; per-provider instructions; plain error naming what was found; say plainly that the record must stay.

Complaints to avoid: manual DNS that takes "two or three days" with no feedback (Search Console's own words); the Cloudflare orange-cloud trap (Resend's warning); a check button that is the only way to learn the status.

### Step 4. Read every page and show a coverage receipt

Leader: Search Console Page indexing report (https://support.google.com/webmasters/answer/7440203), with Yoast's progress step and Plausible's automatic background check.

Search Console layout:

1. Two counts above the chart: indexed and not indexed.
2. Table "Why pages aren't indexed" with columns Status, Reason, Source.
3. Reason names in Google's words: "Server error (5xx)", "Redirect error", "URL blocked by robots.txt", "URL marked 'noindex'", "Soft 404", "Blocked due to unauthorized request (401)", "Not found (404)", "Blocked due to access forbidden (403)", "Crawled - currently not indexed", "Discovered - currently not indexed".
4. Click a row: affected URLs, history, a graph over time, open URL, open URL Inspection, copy URL.
5. **Validate fix**, with states Not started, Started, Looking good, Passed, N/A, Failed.

G2 reviewers credit this report: "The Indexing and Page Experience reports quickly identify crawl issues, indexing errors" (2 July 2026); and fault its delay: "the data is not real-time and typically has a delay of one to two days" (2 July 2026), "some reports take a while to update" (22 August 2026). Source: https://www.g2.com/products/google-search-console/reviews.

Yoast first-time configuration, step "SEO data optimization" (https://yoast.com/help/yoast-seo-first-time-configuration/): Yoast reads every indexable object on the site with a progress bar; "If you have a lot of content, this step may take a while"; the rest of the setup goes on while it runs. Yoast holds 4.8 stars over 27,821 WordPress.org ratings.

Plausible (https://plausible.io/docs/troubleshoot-integration): "Our testing tool launches automatically in the background"; "A banner at the top shows the progress and result."

Credited patterns: a count for each bucket; a reason for every page left out, in plain words; click through to the page itself; the long job runs while the user does other things; email when done (Search Console sends email on new issues; Semanto's tracker already does this).

Complaints to avoid: one-to-two-day delays; reason names that only an SEO understands ("Discovered - currently not indexed").

### Step 5. Review and confirm

Leader: Yoast first-time configuration (4.8 stars, 27,821 ratings), with Stripe's "Save for later" (Capterra Ease of Use 4.5, 3,390 reviews).

Yoast steps, in its words (https://yoast.com/help/yoast-seo-first-time-configuration/; button labels confirmed in a WordPress.org support thread, https://wordpress.org/support/topic/other-profiles-missing-in-sameas/):

1. Yoast SEO menu, the First-time configuration opens.
2. "SEO data optimization", **Continue**.
3. "Site representation": organization or person, name, logo; **Save and continue**.
4. "Social profiles": **Add another profile**; **Save and continue**.
5. "Personal preferences"; **Save and continue**.
6. Finish. Each step can be reopened from the Yoast dashboard.

Stripe hosted onboarding (https://docs.stripe.com/connect/hosted-onboarding): the user can press **Save for later** at any point; an expired link sends them to `refresh_url` for a fresh one; "No state is passed with this URL", so the platform reads the account to learn what is done. The tracker already copies this.

Credited patterns: the product fills in what it found, the person corrects; one topic per screen; leave and come back without losing work; the server, not the browser, decides what is done.

### Step 6. Sign the version

Leader: Docusign signing (G2 Ease of Use 9.0, 2,209 reviews), with GitHub's passkey prompt for the act of signing.

Docusign signer path (as quoted by Docusign's community and partner help pages: https://community.docusign.com/esignature-111/how-does-a-designated-signer-sign-1050, https://v2.support.procore.com/process-guides/payee-user-guide/sign-with-docusign):

1. Email, **REVIEW DOCUMENT**.
2. Agree to use electronic records and signatures, **CONTINUE**.
3. **START** takes the signer to the first place to sign.
4. Click the signature tag; choose a style; **ADOPT AND SIGN**.
5. "confirm signing by clicking the **FINISH** button".

Credited patterns: the document is in front of the signer while signing; the product moves them to the next required spot; one final, plain confirm. Ease of Setup is lower (8.6) because senders build envelopes; signers rate the ceremony itself well (Ease of Use 9.0).

Semanto has the advantage that the hosted key needs no adopt-a-signature step: the passkey prompt is the signature.

### Step 7. Install delivery on the host

Leaders: Vercel (Ease of Setup 9.4), Plausible and Fathom per-host guides (Fathom 9.2), WPCode for the head tag on WordPress (4.9 stars, 1,910 ratings), Shopify app embed deep link.

Vercel add domain (https://vercel.com/docs/domains/working-with-domains/add-a-domain):

1. Project, **Settings**, **Domains**.
2. **Add Domain**, type the domain.
3. "The dashboard will automatically display different methods for configuring it": A record for an apex, CNAME for a subdomain, TXT if another account holds it, or nameservers.
4. Records shown with exact values to copy.

Plausible install (https://plausible.io/docs/plausible-script): the snippet is shown during "the process of adding a new site"; integration guides by platform (WordPress plugin, Google Tag Manager, NPM, proxy guides for Cloudflare, Netlify, Vercel); the WordPress plugin is preferred over a manual snippet.

Site Kit by Google (https://support.google.com/tagmanager/answer/11898619): **Plugins**, **Add New**, search "Site Kit", **Install Now**, **Activate**, **Start setup**, **Sign in with Google**, choose account, **Proceed** to verify site ownership, **Allow**, **Add site**. Site Kit writes the ownership tag itself, so the user never pastes a code.

Squarespace (https://support.squarespace.com/hc/en-us/articles/205815908): open the Code Injection panel (Pages, Website Tools, Code Injection), paste in Header, **Save**. Core, Plus and Advanced plans only.

Webflow (https://help.webflow.com/hc/en-us/articles/33961357265299): **Site settings**, **Custom code** tab, **Head code**, **Save changes**, then publish; "they won't go live until your site is published". Paid plans; 50,000 characters.

Shopify: theme app extensions can give merchants "a deep link, post installation, to activate an app embed block automatically" (https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration), and the UX guide says to "Provide a deep link into the theme editor with an app embed block activated" (https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/ux). Shopify requires OAuth "immediately after install" and a redirect "to the app UI after they accept permissions access".

Cloudflare: the repo already offers a Deploy to Cloudflare button for the Worker adapter.

Certbot (https://certbot.eff.org/): a sentence picker, "My HTTP website is running [Software] on [System]", then shows only the commands for that pair. The clearest per-host chooser found.

Credited patterns: pick the host for the user and show only that guide; a plugin or app over a pasted snippet where the platform allows; copy buttons; remind the user to publish or clear cache.

Complaints to avoid, from Site Kit's recent WordPress.org reviews (https://wordpress.org/plugins/google-site-kit/): "half the time Site Kit doesn't work" (5 October 2026); "This whole setup wizzard is completely messed up. Just give users a dashboard and let us insert our API key" (19 August 2026); "slows the site down a lot" (11 September 2026). From Google & YouTube's 1-star reviews: setup that asks for too much ("next it was going to ask for blood and fingerprints", 10 October 2026), syncs that finish partly ("only added 19 items to our Google Merchant account, over 250", 1 July 2026), and failures with "no clear answer as to what specific rule my specific store was failing at" (27 August 2026).

### Step 8. Check it works

Leader: Plausible's automatic installation check, with Postmark's automatic turn-green and its Verify button.

Plausible (https://plausible.io/docs/troubleshoot-integration):

1. After adding the snippet, "your dashboard opens immediately".
2. "A banner at the top shows the progress and result of the installation check. Plausible first checks whether it can reach your site and detect the installation, then confirms if visits are being counted correctly."
3. The test runs "automatically in the background"; test traffic is not counted.
4. On failure, the banner "explains the problem and lets you check again, try another URL, review the installation instructions or verify the installation manually."
5. The check can be run again any time from site settings.
6. A quick checklist names the usual causes: cache not cleared, a plugin altering the script, two snippets, testing on localhost.

Credited patterns: test without being asked; separate "can we reach the site" from "is it working"; each failure names the fix; rerun any time.

### Step 9. Ongoing monitoring

Leader: Peec AI (Ease of Setup 9.7, small sample) and OtterlyAI (9.2), against Profound (8.6, large sample).

Peec quickstart (https://docs.peec.ai/quickstart-guide):

1. "Add your first 10 prompts"; Peec "suggests prompts based on your brand and website" in the **Suggested** tab on the **Prompts** page, or **Add** your own.
2. "While your prompts run, Peec AI detects competitor brands mentioned in AI responses and suggests them"; accept, or **+ Add brand**.
3. "less than 10 minutes", first insights "within 24 hours".

Otterly (https://help.otterly.ai/what-is-otterly.ai): "Your first Brand Report is created automatically during setup"; "first results typically appear in a couple of minutes"; "monitoring runs automatically every day". A customer quote on its homepage: "I was monitoring our first set of brand and product specific triggers within one hour" (https://otterly.ai/).

Complaints to avoid, Profound's G2 reviews (https://www.g2.com/products/profound/reviews): "theres a lot of data vailable and its not always obvious where to start" (17 June 2026); "a significant learning curve" (27 August 2026); "it takes a bit of a learning curve to understand where to look for things and what certain terms mean in Profound definitions" (2 June 2026).

Credited patterns: suggest the questions and the competitors from the site; create the first report during setup; show the first results within minutes; plain names for every measure.

---

## 5. Recommended Semanto click path

Rules applied throughout: Trooth "witnesses"; no screen applies the past participle of "verify" or "certify" to a company; no number is presented as a ranking; no ellipses in any label or message; plain words; blue only on the one primary button per screen; every other control is a plain or outline button. Every screen saves state on the server, so the owner can leave and return to the same place from any email link (Stripe's `refresh_url` pattern, already in the tracker).

Screens group the nine steps into six screens so no screen asks for more than one decision (Chameleon: three-step flows finish at 72%).

### Timing targets

| Step | Basic, seconds | Full, seconds | Who |
| --- | --- | --- | --- |
| 1 Sign in | 30 | 30 | Owner |
| 2 Company and website | 30 | 30 | Owner |
| 3 Prove the domain (one click / by hand) | 90 / 270 | 90 / 270 | Owner, then Trooth |
| 4 Read the site and show the receipt | 180 (runs during step 3) + 60 to read the receipt | same | Trooth, then owner |
| 5 Review and confirm | not in Basic | 60 | Owner |
| 6 Sign | not in Basic | 45 | Owner |
| 7 Install delivery | not in Basic | 120 | Owner |
| 8 Check it works | not in Basic | 30 | Trooth |
| 9 Monitoring | not in Basic | 30 | Trooth, then owner |
| Total, worst case (by-hand DNS, read not overlapped) | 30+30+270+180+60 = 570 (9.5 min) | 570+60+45+120+30+30 = 855 (14.25 min) | |
| Total, one-click DNS with the read overlapped | 30+30+90+60 = 210 plus any read time left over | about 495 to 675 | |

The read can overlap step 3 because the public site is public: Semanto starts reading as soon as the website is named and holds the result, unpublished, until the domain is proved. Section 6 lists the change this needs in `tier.ts`.

---

### Screen A. Sign in (step 1)

Copies: GitHub's passkey prompt at sign-in; Shopify's "sign up with the account you already have"; Trooth's own magic-link finding.

Controls:

- **Continue with Google** (outline)
- **Continue with email** (primary, blue): one field, "Work email"
- After the email link is opened: the device offers a passkey. **Save a passkey** (primary) and **Not now** (plain link).

What happens: the email link signs the owner in directly (no return to type a password). The passkey offer appears once, after sign-in, never as a gate.

States:

- Empty: "Sign in to Semanto by Trooth. Use your work email so Trooth can match you to your company's domain."
- Loading: "Sending your sign-in link"
- Error: "That link has expired. We sent a new one to <email>." / "Your device did not save the passkey. You can sign in with your email link every time, or try again later in Settings."
- Success: goes straight to Screen B.

Target: 30 seconds.

### Screen B. Your company (step 2)

Copies: Plausible's single domain field; Vercel's www prompt; Resend's domain-claim notice.

Controls:

- "Company name" (text)
- "Website" (text; accepts `https://www.example.com/about` and keeps `example.com`)
- **Continue** (primary)

What happens on Continue: Semanto cleans the address, shows "We will use example.com" under the field, checks whether another Trooth workspace holds the domain, starts host detection (`detect.ts`) and starts reading public pages in the background.

States:

- Empty: placeholder "example.com".
- Loading: "Checking example.com"
- Error: "We could not reach example.com. Check the spelling, or that the site is online." / "example.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim." (existing `claimed_elsewhere` words)
- Success: Screen C, with the line "Semanto has started reading your site. Keep going."

Target: 30 seconds.

### Screen C. Prove you control example.com (step 3)

Copies: Search Console's "Domain name provider" with **Start verification**; Resend's **Auto configure**; Postmark's automatic turn-green plus **Verify**; Trooth's `dns-diagnosis.ts` words.

Layout, when Domain Connect discovery finds an onboarded provider (Cloudflare, GoDaddy, IONOS, Vercel, WordPress.com, NameSilo, Plesk once each has onboarded Trooth's template):

- Line: "Your domain's DNS is at Cloudflare. Trooth can add the record for you. You will sign in at Cloudflare and approve two records. Nothing else changes."
- **Add it at Cloudflare** (primary)
- **I'll add it myself** (plain link, opens the manual layout)
- **Send these steps to the person who manages our domain** (plain link; the existing developer handoff, a signed link that expires in 7 days)

Layout, manual (no onboarded provider found, or the owner chose it):

- A three-row table: Type `TXT`, Name `_trooth` (with "Some hosts want only `_trooth`; others want `_trooth.example.com`. Try the first."), Value. A **Copy** button on each value.
- A short guide for the detected DNS host (GoDaddy, Namecheap, Cloudflare, Squarespace, Wix and others), chosen automatically; a "Not your host?" switch.
- Cloudflare note when relevant: "Leave the cloud gray (DNS only) for this record." Not needed for TXT, so shown only when a CNAME is involved.
- **I've added it** (primary). Trooth then checks on its own, every few seconds at first, then less often, for up to 72 hours. A plain **Check now** link appears after the first check.
- Alternative tab: "Upload a file instead", for owners who cannot reach DNS: the file name `/.well-known/trooth-claim.txt`, its contents with **Copy**, and **Download the file**.

What happens: on return from the provider, or on "I've added it", the screen goes to "Looking for your record" and polls. A return from the provider is not proof; only finding the record is (`readReturn` already says this).

States (words from `dns-diagnosis.ts`, which already avoid the past participle of "verify"):

- Empty: "Add the record, then tell Trooth."
- Loading: "Looking for your record. Most hosts publish a new record within minutes. You can leave this page: Trooth keeps looking and emails you when it is found."
- Error: "Almost: your DNS host added your domain to the name twice. Edit the record and change Name to `_trooth`." / "A record is there, but the value does not match. Paste it again with the Copy button." / "Trooth stopped looking after 72 hours. Check the record with your DNS host, then press Look again." / Provider declined: "You cancelled at Cloudflare. Nothing was changed. Try again, or add it yourself."
- Success: "You proved control of example.com. Keep the record in place: Trooth looks again every day." The row turns to a check mark without a click, and the screen moves on after two seconds.

Target: 90 seconds one-click, 270 seconds by hand including the check.

### Screen D. What Semanto read (step 4, the coverage receipt)

Copies: Search Console's Page indexing report (two counts, a reasons table, click through); Yoast's progress step; Plausible's progress banner; Otterly's "first report during setup".

Layout:

- Progress line while reading: "Reading your site: 47 of 212 pages" with a bar that moves on real counts (the tracker's `progress.done / progress.total`).
- When done, three counts in a row: **Found** 212, **Read** 198, **Left out** 14.
- "Left out" table, one row per reason, each reason in plain words with the page count and a **See pages** link:
  - "Asked search engines not to show it (noindex)"
  - "Blocked by your robots.txt"
  - "Page not found (404)"
  - "Server error (5xx)"
  - "Needs a login"
  - "Same page as another one"
  - "Too large to read"
  - "Not reached: no link to it from your site or sitemap"
- Each page row: the address, **Open page**, **Copy address**.
- Basic notice, always present, from `WITNESSED_NOT_SIGNED`: "This record is witnessed by Trooth and not signed by the company. Semanto Basic builds it from the public site; the company has not signed it."
- Basic primary: **Finish setup** (blue). For Basic this ends the path; the receipt is the first value.
- Next-step card (outline button): **Sign it as your company** leads to Screen E (full tier). The head-tag line and the first competitor report are offered here as optional extras, not counted in the ten minutes.
- **Read again** (plain) after the owner fixes a left-out page.

States:

- Empty: never empty on arrival, because the read started at Screen B. If the read has not begun: "Semanto starts reading as soon as your domain is proved."
- Loading: "Reading your site: 47 of 212 pages. You can close this page. We will email you when it is done."
- Error: "Semanto could not reach example.com after 3 tries. Your site may be down or blocking readers. Try again, or check that example.com opens in a browser." / A partial read is shown as a partial receipt with "Stopped at 120 of 212 pages" and **Continue reading**, never as finished.
- Success: the three counts and the table; email "Semanto read 198 of 212 pages on example.com".

Target: 180 seconds of reading (overlapped with Screen C) and 60 seconds for the owner to look.

Basic total at this point: 570 seconds worst case.

### Screen E. Review and sign (steps 5 and 6)

Copies: Yoast's step-by-step confirm with **Save and continue**; Stripe's **Save for later**; Docusign's document-in-view, **START** to the next spot, one **FINISH**; GitHub's passkey prompt.

Layout, review (step 5):

- The facts Semanto found, grouped in at most four short sections (Company, Products, Contact and hours, Policies), each fact with the page it came from.
- Per fact: **Looks right** (default, already ticked) and **Fix** (opens an inline field). Nothing needs a click unless it is wrong.
- **Save for later** (plain) at the top right.
- **Confirm these facts** (primary).

Layout, sign (step 6):

- One sentence: "You are signing version 1 of example.com's Semanto record: 198 pages and 64 facts. Signing says these words came from your company. It does not say they are true; anyone can check who signed."
- Key choice, preselected to the hosted key: "Trooth keeps the key, your passkey releases it" (default) or "Use our own key" (opens the existing key-binding panel).
- **Sign with my passkey** (primary). The device prompt appears; that is the signature.

What happens: the signature is made; the version is published to the Trooth Network; the `_trooth` pointer record is added (through Domain Connect when available, the same template's second record).

States:

- Empty: not applicable; facts are prefilled.
- Loading: "Signing version 1"
- Error: "Your device did not finish the passkey step. Nothing was signed. Try again." / "This version changed while you were reviewing (3 pages were updated). Review the changes, then sign."
- Success: "Signed by Example Inc. on 22 October 2026. Trooth witnessed the signing." Continue to Screen F.

Target: 60 seconds review, 45 seconds sign.

### Screen F. Put it on your site (steps 7, 8 and 9)

Copies: Certbot's one-sentence host picker and Vercel's automatic method choice; Plausible's per-host guides and automatic background check; Site Kit's "the plugin does it for you", without its long wizard; Shopify's app embed deep link; Peec's suggested prompts and competitors; Otterly's first report during setup.

Layout, install (step 7):

- Sentence, filled from `detect.ts`: "Your site runs on **Shopify**." with a **Change** link that opens a list (Cloudflare, Vercel, Netlify, WordPress, Shopify, Webflow, Squarespace, Wix, nginx, Apache, Other).
- Only the guide for that host, at most four lines, one action:
  - Cloudflare: **Deploy to Cloudflare** (primary), then "Pick example.com and press Deploy."
  - Vercel: **Add to Vercel** (primary) and the two files.
  - Netlify: **Copy the two lines for \_redirects** (primary) or the edge function.
  - WordPress: **Get the plugin** (primary), then "Plugins, Add New, Upload, Activate. The plugin connects itself."
  - Shopify: **Install the Shopify app** (primary); after Shopify's permission screen the app opens the theme editor with the Semanto embed already switched on; the owner presses **Save**.
  - Webflow: **Copy the head code** (primary), then "Site settings, Custom code, Head code, Save changes, then Publish."
  - Squarespace: **Copy the head code** (primary), then "Pages, Website Tools, Code Injection, Header, Save."
  - Wix: **Copy the head code** (primary), then "Settings, Custom code, Add code, Head, All pages, Apply."
  - nginx, Apache: **Copy the config** (primary).
- **Send to my developer** (plain): the existing developer handoff.

Layout, check (step 8), starts by itself the moment the install is saved and can be rerun:

- Three checks, each turning to a check mark on its own:
  - "Trooth can reach example.com"
  - "Your site answers markdown when asked (Accept: text/markdown)"
  - "The signature on what your site sends matches what you signed"
- **Check again** (plain).

Layout, monitoring (step 9):

- "Questions Semanto will ask AI assistants about you", ten suggested from the site, each removable; **Add a question**.
- "Companies to compare", up to three suggested; **Add a company**.
- **Start monitoring** (primary). The first report runs at once.

States:

- Empty: if no host was detected, the sentence reads "We could not tell where your site runs. Pick it from the list." with the list open.
- Loading: "Checking example.com: 1 of 3 done" / "Asking 4 AI assistants your first 10 questions. First answers usually take a few minutes; we will email you."
- Error, check 1: "Trooth could not reach example.com. Is the site online?" Check 2: "Your site sent a web page, not markdown. The app or code is not live yet. On Webflow and Squarespace, publish the site; on WordPress, clear the cache; then press Check again." Check 2, Cloudflare conflict (`DOUBLE_MARKDOWN_MESSAGE`): "Cloudflare's converter answered instead of Semanto. In the Worker settings, make Semanto run first." Check 3: "Your site sent a copy that does not match what you signed. A page changed after signing. Sign the new version, or keep serving the signed one."
- Success: "example.com is serving your signed Semanto record." Then the monitoring screen: "First answers are in" with the first mismatch, if any, phrased as "ChatGPT says your hours are 9 to 5. Your site says 8 to 6." Alerts: "Email me when an assistant says something different from my site" (on by default).

Targets: 120 seconds install, 30 seconds check, 30 seconds to start monitoring.

Full total: 855 seconds worst case, 14.25 minutes.

### Persistent elements on every screen

- A slim tracker across the top: "Step 3 of 6: Prove your domain", from the existing tracker component, in neutral colors.
- Server-saved state; every email links to the current screen.
- "You can close this page" when Trooth is doing the work; email only when something needs the owner (Vercel's failure-only alerts, already in the tracker).
- One blue button per screen. Destructive or secondary actions are outline or plain.

---

## 6. Changes needed to align the repo with this path

1. Pick one proof record. `tier.ts` uses `_trooth` with `v=trooth1; claim=<token>`; `domain-connect.ts` and `dns-diagnosis.ts` use `_trooth-challenge` with `trooth-domain-challenge=<48 hex>` and reserve `_trooth` for the pointer `v=trooth1; id=; key=`. Domain Connect's prefix conflict matching and the pointer both work better with the blueprint's split; `tier.ts`, `detect.ts` (`/^v=trooth1;/` matches both kinds today) and the manual table should follow it.
2. Start the read at Screen B. Today `buildBasic` refuses until `domain_proved`. Split it: read and hold from the moment the website is named; build and publish only after proof. This keeps the Basic path under ten minutes even with by-hand DNS.
3. Replace `SETUP_CHECKLIST` with the nine steps and the targets in section 5 (Basic steps 1 to 4 sum to 570 seconds worst case; full steps 1 to 9 to 855). Keep `measureSetup` as it is; it already measures from timestamps. Move the head tag and first report out of the Basic ten minutes, or keep them as optional rows that do not count toward `within_ten_minutes`.
4. Onboard the Domain Connect template. Submit `trooth.co.domainclaim.json` to `github.com/Domain-Connect/templates`; after merge, email Cloudflare (`domain-connect@cloudflare.com`) and Vercel, then GoDaddy and IONOS (addresses listed at https://www.domainconnect.org/dns-providers/). Add each to `ONBOARDED` only when that provider confirms.
5. Add Shopify, Webflow, Squarespace and Wix to `HostKind` and to `classifyHost`, so Screen F can choose the guide by itself. Detection signals to confirm with a live test before shipping: Shopify (`powered-by: Shopify` or `x-shopid` header, `cdn.shopify.com` in the page), Squarespace (`server: Squarespace`), Wix (`x-wix-request-id` header), Webflow (`<meta name="generator" content="Webflow">`). These were not checked live in this research.
6. Rename the tracker's header comment from "Trooth Live Verification Pending" to "Setting up Semanto", and align its six steps with the six screens above (Sign in, Your company, Prove your domain, What Semanto read, Review and sign, Put it on your site). Witness and Trust Profile steps belong to Trooth's other product paths, not Semanto setup.
7. Build the automatic install check (Screen F, step 8) on `detect.ts`: it already fetches `/` with `Accept: text/markdown`, reads the well-known files and compares bytes to the Network copy. Add the signature check on the returned markdown and the three plain messages above.

---

## Sources seen on 22 October 2026

G2: https://www.g2.com/compare/peec-ai-vs-profound, https://www.g2.com/compare/netlify-vs-vercel, https://www.g2.com/compare/cloudflare-application-security-and-performance-vs-vercel, https://www.g2.com/compare/activecampaign-postmark-vs-resend, https://www.g2.com/compare/rank-math-vs-seopress, https://www.g2.com/compare/fathom-analytics-vs-plausible-analytics, https://www.g2.com/compare/bing-webmaster-tools-vs-google-search-console, https://www.g2.com/compare/akamai-cloud-computing-vs-cloudflare-application-security-and-performance, https://www.g2.com/compare/otterlyai-vs-scrunch-ai, https://www.g2.com/compare/paypal-vs-stripe-connect, https://www.g2.com/compare/squarespace-vs-wix, https://www.g2.com/compare/adobe-acrobat-sign-vs-docusign, https://www.g2.com/products/profound/reviews, https://www.g2.com/products/google-search-console/reviews

WordPress.org API: https://api.wordpress.org/plugins/info/1.2/ (slugs wordpress-seo, google-site-kit, seo-by-rank-math, really-simple-ssl, plausible-analytics, fathom-analytics, insert-headers-and-footers)

Shopify: https://apps.shopify.com/google, https://apps.shopify.com/google/reviews?ratings%5B%5D=1, https://apps.shopify.com/yoast-seo, https://shopify.dev/docs/apps/launch/built-for-shopify/requirements, https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements, https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration, https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/ux

Capterra: https://www.capterra.com/p/155191/Cloudflare/, https://www.capterra.com/p/123889/Stripe/

Benchmarks: https://userpilot.com/blog/time-to-value/, https://userpilot.com/saas-product-metrics/, https://userpilot.com/blog/product-metrics-benchmark-report/, https://www.chameleon.io/blog/effective-product-tour-metrics, https://www.chameleon.io/blog/mastering-product-tours, https://www.appcues.com/blog/time-to-value, https://www.appcues.com/blog/user-onboarding-metrics-and-kpis

Flows: https://support.google.com/webmasters/answer/9008080, https://support.google.com/webmasters/answer/7440203, https://resend.com/docs/add-a-domain, https://postmarkapp.com/support/article/how-do-i-verify-a-domain, https://www.domainconnect.org/dns-providers/, https://developers.cloudflare.com/dns/reference/domain-connect/, https://vercel.com/docs/domains/domain-connect, https://vercel.com/docs/domains/working-with-domains/add-a-domain, https://developers.cloudflare.com/fundamentals/manage-domains/add-site/, https://plausible.io/docs/add-website, https://plausible.io/docs/plausible-script, https://plausible.io/docs/troubleshoot-integration, https://support.google.com/tagmanager/answer/11898619, https://yoast.com/help/yoast-seo-first-time-configuration/, https://docs.stripe.com/connect/hosted-onboarding, https://docs.github.com/en/authentication/authenticating-with-a-passkey/managing-your-passkeys, https://community.docusign.com/esignature-111/how-does-a-designated-signer-sign-1050, https://v2.support.procore.com/process-guides/payee-user-guide/sign-with-docusign, https://support.squarespace.com/hc/en-us/articles/205815908, https://help.webflow.com/hc/en-us/articles/33961357265299, https://certbot.eff.org/, https://docs.peec.ai/quickstart-guide, https://help.otterly.ai/what-is-otterly.ai, https://otterly.ai/, https://www.semrush.com/kb/1487-otterly-ai-search-monitoring

Prior Trooth research used: Project docs `claude/trooth-competitive-benchmark-2026-07-26.md`, `claude/trooth-core-flows-ux-phase1-2-2026-10-16.md`, `claude/trooth-semanto-stress-test-audit-2026-10-16.md`.
