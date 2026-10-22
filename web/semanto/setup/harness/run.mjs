// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// One command for the browser walk: build the harness page, start the mock
// setup API, launch headless Chromium (playwright-core with the container's
// headless shell, or PLAYWRIGHT_CHROMIUM when set), run wizard.test.mjs, and
// print the result. `node run.mjs --serve` builds and serves the page for a
// person to click through. Screenshots go to SETUP_SHOTS_DIR or a folder in
// the system temp folder, never the repository. Not shipped.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildHarness } from "./build.mjs";
import { startMockServer } from "./mock-server.mjs";
import { runAll } from "./wizard.test.mjs";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
const shots = process.env.SETUP_SHOTS_DIR || join(tmpdir(), "semanto-setup-shots");

const t0 = Date.now();
const out = await buildHarness();
const { server, port } = await startMockServer({ staticDir: out, port: Number(process.env.PORT ?? 0) });
const base = `http://localhost:${port}`;

if (process.argv.includes("--serve")) {
  console.log(`Harness at ${base}/?token=full-demo (try token=basic-demo, customer-demo, officer-demo, dc-demo, errors-demo, timeout-demo, unknownhost-demo, or no token for sign-in)`);
} else {
  const browser = await chromium.launch({ executablePath });
  let code = 0;
  try {
    const r = await runAll({ browser, base, shots });
    console.log(JSON.stringify({ ok: true, seconds: Math.round((Date.now() - t0) / 100) / 10, walk_seconds: Math.round(r.ms / 100) / 10, clicks: r.clicks, error_paths: r.errors, polling: r.polling, screenshots: shots }, null, 2));
  } catch (e) {
    code = 1;
    console.error(e instanceof Error ? e.stack : e);
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(code);
}
