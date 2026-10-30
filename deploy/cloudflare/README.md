# Semanto by Trooth for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/troothllc/trooth-semanto-worker/tree/main/deploy/cloudflare)

A Worker on your Cloudflare zone. When an AI agent asks for a page, it answers with the signed copy Trooth holds for you. Every other request goes to your site as before. If Trooth is slow or down, your site keeps answering.

1. Press **Deploy to Cloudflare** and paste your Trooth ID when asked.
2. Open the new Worker, then **Settings**, **Domains & Routes**, **Add**, **Route**. Pick your domain, type your domain followed by `/*`, and press **Add route**.
3. In Trooth, press **Check my site**.

The full guide: https://trooth.co/docs/semanto/install/cloudflare-worker

Built from `adapters/cloudflare-worker` by `scripts/build-deploy.mjs`. Change the sources there, not here.
