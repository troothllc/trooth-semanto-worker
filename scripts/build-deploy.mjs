#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Builds deploy/cloudflare: the Cloudflare adapter as one self-contained folder, which is what the
// Deploy to Cloudflare button needs (developers.cloudflare.com/workers/configuration/deploy-button/:
// a subdirectory becomes the root of the customer's new repository, so nothing may import from
// outside it). The sources stay in adapters/; this copies them and rewrites the one import.
//
//   node scripts/build-deploy.mjs           writes deploy/cloudflare
//   node scripts/build-deploy.mjs --check   exits 1 if deploy/cloudflare is not what it would write

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "deploy/cloudflare");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

const files = {
  "src/index.ts": src("adapters/cloudflare-worker/src/index.ts").replace('"../../shared/semanto-adapter.mjs"', '"./semanto-adapter.mjs"'),
  "src/semanto-adapter.mjs": src("adapters/shared/semanto-adapter.mjs"),
  "src/sign-request.mjs": src("adapters/shared/sign-request.mjs"),
  "wrangler.toml": `# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Built by scripts/build-deploy.mjs from adapters/cloudflare-worker. Do not edit here.
# The Deploy to Cloudflare button asks for TROOTH_ID. After it deploys, add a route for
# your domain in the Worker's Settings, Domains & Routes. Until TROOTH_ID is set, every
# request goes to your site unchanged.

name = "trooth-semanto"
main = "src/index.ts"
compatibility_date = "2026-10-01"
workers_dev = false
preview_urls = false

[vars]
TROOTH_ID = ""
TROOTH_API_BASE = "https://api.trooth.co"
MODE = "semanto_only"

[observability]
enabled = true
`,
  "package.json": JSON.stringify({
    name: "trooth-semanto",
    version: "0.1.0",
    private: true,
    type: "module",
    license: "LicenseRef-Trooth-Proprietary",
    description: "Semanto by Trooth on your Cloudflare zone: agents get your signed copy, everyone else gets your site.",
    scripts: { deploy: "wrangler deploy" },
    devDependencies: { wrangler: "^4.40.0" },
    cloudflare: {
      bindings: {
        TROOTH_ID: { description: "Your Trooth ID. Copy it from **Put it on your site** in your [Trooth dashboard](https://trooth.co/dashboard/semanto/install)." },
        TROOTH_API_BASE: { description: "Leave as it is." },
        MODE: { description: "Leave as `semanto_only`." },
      },
    },
  }, null, 2) + "\n",
  "README.md": `# Semanto by Trooth for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/troothllc/trooth-semanto-worker/tree/main/deploy/cloudflare)

A Worker on your Cloudflare zone. When an AI agent asks for a page, it answers with the signed copy Trooth holds for you. Every other request goes to your site as before. If Trooth is slow or down, your site keeps answering.

1. Press **Deploy to Cloudflare** and paste your Trooth ID when asked.
2. Open the new Worker, then **Settings**, **Domains & Routes**, **Add**, **Route**. Pick your domain, type your domain followed by \`/*\`, and press **Add route**.
3. In Trooth, press **Check my site**.

The full guide: https://trooth.co/docs/semanto/install/cloudflare-worker

Built from \`adapters/cloudflare-worker\` by \`scripts/build-deploy.mjs\`. Change the sources there, not here.
`,
};

const check = process.argv.includes("--check");
let stale = [];
for (const [rel, body] of Object.entries(files)) {
  const p = join(OUT, rel);
  if (check) { if (!existsSync(p) || readFileSync(p, "utf8") !== body) stale.push(rel); continue; }
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}
if (check) {
  const walk = (d) => readdirSync(join(OUT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of existsSync(OUT) ? walk("") : []) if (!(f in files)) stale.push(`${f} (not built here)`);
  if (stale.length) { console.error(`deploy/cloudflare is stale: ${stale.join(", ")}. Run node scripts/build-deploy.mjs`); process.exit(1); }
  console.log("deploy/cloudflare matches its sources");
} else console.log(`wrote ${Object.keys(files).length} files to deploy/cloudflare`);
