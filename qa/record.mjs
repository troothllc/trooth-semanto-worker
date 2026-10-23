// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Write the QA walk's two clean runs into trooth-web's rendered-browser record
// (docs/writing/W3-BROWSER-RECORD.json), in the shape the W3-81 and W3-82 runs
// use: one entry per run under `runs`, and per route the run's states under
// `passes`, with `run` set to the latest pass. Reads the walks' own records
// (qa/.run/walk-<run id>/walk.json); refuses a run that has any finding.
//
//   node qa/record.mjs W3-83-semanto-qa W3-83-semanto-qa-light
import { readFileSync, writeFileSync } from "node:fs";

const WEB = process.env.TROOTH_WEB_DIR || new URL("../../trooth-web/", import.meta.url).pathname;
const FILE = `${WEB}docs/writing/W3-BROWSER-RECORD.json`;
const [dark, light] = process.argv.slice(2);
if (!dark || !light) throw new Error("usage: node qa/record.mjs <dark run id> <light run id>");

const walk = (id) => JSON.parse(readFileSync(new URL(`./.run/walk-${id}/walk.json`, import.meta.url), "utf8"));
const runs = [walk(dark), walk(light)];
for (const r of runs) if (r.findings.length) throw new Error(`${r.runId} has ${r.findings.length} findings; only a clean run is recorded`);

// The defects this QA found and fixed, by the route they showed on (trooth-semanto-worker docs/program/reports/qa.md).
const EVERY = ["QA-02", "QA-07", "QA-12"];
const FIXED = {
  "/dashboard/semanto": [],
  "/dashboard/semanto/read": [],
  "/dashboard/semanto/sign": ["QA-01", "QA-10"],
  "/dashboard/semanto/install": ["QA-03", "QA-04", "QA-05"],
  "/dashboard/semanto/monitor": [],
  "/dashboard/semanto/delivery": ["QA-06"],
  "/dashboard/semanto/keys": ["QA-10"],
  "/dashboard/semanto/receipts": ["QA-08"],
  "/dashboard/semanto/connectors": ["QA-17"],
  "/dashboard/semanto/connect/[session]": ["QA-16"],
  "/dashboard/semanto/connections": [],
  "/dashboard/semanto/company": ["QA-11", "QA-17"],
  "/dashboard/semanto/writeback": ["QA-14", "QA-17", "QA-19"],
  "/dashboard/semanto/sellers": ["QA-15"],
  "/dashboard/semanto/recalls": ["QA-15", "QA-17", "QA-18"],
  "/dashboard/semanto/credentials": ["QA-13", "QA-17"],
};
const routeOf = (url) => {
  const path = url.split("?")[0];
  if (/^\/dashboard\/semanto\/connect\/[^/]+$/.test(path)) return "/dashboard/semanto/connect/[session]";
  return path in FIXED ? path : null;
};

const SCOPE = "the live local Semanto Worker under workerd (D1, R2, KV, queue, Durable Objects) with worker-f behind a TROOTH_OS stand-in, Google and Resend at loopback stand-ins, real data the walk made; dark and light themes at 1568x741 and 390x844; real Google consent, a real Shopify admin, Safari and Firefox not seen";
const SERVER = "next start (production build) on http://localhost:47120 through trooth-web's journeys stack (scripts/journeys/stack.mjs: a throwaway Postgres 16, the neon-http shim, the preload that sends https://api.trooth.co to the loopback api front), SEMANTO_DASHBOARD set to true in lib/launch-config.ts for the run only (set back to false after); the trooth-semanto-worker Worker bundled with wrangler and run under Miniflare with D1 (migrations 0001 to 0008), R2, KV, the queue consumer and the Durable Objects, a fresh witness key, seal secret and SEMANTO_EVENTS_SECRET; trooth-os-worker-f run the same way for the recall feeds; personas signed in by the journeys stand-in's tokens in the trooth_session cookie, never a production credential (trooth-semanto-worker qa/README.md)";

const rec = JSON.parse(readFileSync(FILE, "utf8"));
for (const r of runs) {
  const routes = new Set(r.states.map((s) => routeOf(s.url)).filter(Boolean));
  const walks = r.states.filter((s) => s.keyboard).length;
  rec.runs[r.runId] = {
    record: "docs/writing/W3-83-RENDER-SEMANTO-QA.md",
    dates: r.at.slice(0, 10),
    server: SERVER,
    browser: `Playwright Chromium (build 1194), headless, prefers-reduced-motion: reduce, axe-core ${r.axe} with the WCAG 2.0, 2.1 and 2.2 A and AA rules and Label in Name (2.5.3), ${r.theme} color scheme and trooth-theme=${r.theme}, a Chrome virtual authenticator for the signing passkey`,
    viewports: ["1568x741 @1", "390x844 @1"],
    scope: `the Semanto QA walk (trooth-semanto-worker docs/program/reports/qa.md): every workflow of items 1 to 8 against the live Worker, ${r.states.length} states on ${routes.size} addresses, axe-core clean on all, ${walks} keyboard walks reaching every control, no console or page error and no failed request; roles (owner, admin, member, viewer, a teammate with no role, another company), outages (the Worker down and slow, worker-f's session check down), the security probes and the phone width`,
    notRun: "real Google consent and Merchant Center, a real Shopify admin, Safari, Firefox and screen readers: covered by stand-ins at the network boundary and by each repository's suites",
  };
  for (const route of routes) {
    const states = Object.fromEntries(r.states.filter((s) => routeOf(s.url) === route).map((s) => [`${s.name.startsWith("phone-") ? "390x844" : "1568x741"} ${r.theme}, ${s.name}`, "clean"]));
    const fixed = [...EVERY, ...FIXED[route]];
    const pass = { result: "fixed", loadedAs: r.states.find((s) => routeOf(s.url) === route).url, states, scope: SCOPE, note: `fixed and re-walked clean: ${fixed.join(", ")} (trooth-semanto-worker docs/program/reports/qa.md)` };
    const entry = rec.routes[route] ?? { passes: {} };
    entry.passes = { ...(entry.passes ?? {}), [r.runId]: pass };
    entry.run = r.runId;
    entry.result = "fixed";
    entry.loadedAs = pass.loadedAs;
    entry.scope = SCOPE;
    rec.routes[route] = entry;
  }
}
writeFileSync(FILE, `${JSON.stringify(rec, null, 1)}\n`);
console.log(`recorded ${runs.map((r) => r.runId).join(" and ")} in ${FILE}`);
