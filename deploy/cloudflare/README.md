# Semanto by Trooth for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/troothllc/trooth-semanto-worker/tree/main/deploy/cloudflare)

A Worker on your Cloudflare zone. When an AI agent asks for a page, it answers with the signed copy Trooth holds for you. Every other request goes to your site as before. If Trooth is slow or down, your site keeps answering.

1. Press **Deploy to Cloudflare**, paste your Trooth ID into **TROOTH_ID**, leave everything else as it is, and press **Deploy**.
2. When it finishes, open the **Domains** tab and press **Add Route**. For **Zone** pick your domain, for **Route** type your domain followed by `/*`, then press **Add Route**.
3. In Trooth, press **Check my site**.

If the build stops at *could not push contents of source repo to destination repo*, your GitHub organization blocks force pushes on every repository: add the **Cloudflare Workers and Pages** app to that rule's bypass list, then press **Retry build**.

The full guide: https://trooth.co/docs/semanto/install/cloudflare-worker

Built from `adapters/cloudflare-worker` by `scripts/build-deploy.mjs`. Change the sources there, not here.
