#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The full QA walk against the running stack (qa/run.sh start). Every section
// is a person using the dashboard; between sections the walk reads what each
// action left behind (the Worker's D1, worker-f's feeds, the captured email).
//
//   QA_THEME=dark|light  QA_RUN_ID=<id>  QA_ONLY=<section,section>  node qa/walk/walk.mjs
// Writes screenshots and walk.json to qa/.run/walk-<run id>/. Exit 1 on any finding.

import { startWalk, writeRecord, STACK, d1 } from "./lib.mjs";
import { setupGuide } from "./setup.mjs";
import { delivery } from "./delivery.mjs";
import { keys, keysCustomer, keysOld } from "./keys.mjs";
import { receipts } from "./receipts.mjs";
import { connectors } from "./connectors.mjs";
import { connectShopify } from "./connect.mjs";
import { google } from "./google.mjs";
import { companySettings } from "./company.mjs";
import { writeback } from "./writeback.mjs";
import { sellersHosted, sellersCustomer, sellersOldKeys } from "./sellers.mjs";
import { recallsHosted, recallsCustomer } from "./recalls.mjs";
import { credentials } from "./credentials.mjs";
import { roles } from "./roles.mjs";
import { outages } from "./outages.mjs";
import { security } from "./security.mjs";
import { phone } from "./phone.mjs";

const theme = process.env.QA_THEME === "light" ? "light" : "dark";
const runId = process.env.QA_RUN_ID || `W3-83-semanto-qa${theme === "light" ? "-light" : ""}`;
const out = new URL(`../.run/walk-${runId}`, import.meta.url).pathname;
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const w = await startWalk({ theme, out, runId });
const ctx = { domain: STACK.companies.acme.domain, troothId: null };
const sections = [
  ["setup", setupGuide], ["delivery", delivery], ["keys", keys], ["receipts", receipts], ["connectors", connectors], ["connect", connectShopify],
  ["google", google], ["company", companySettings], ["writeback", writeback], ["sellers", sellersHosted], ["recalls", recallsHosted], ["credentials", credentials],
  ["keys-customer", keysCustomer], ["sellers-customer", sellersCustomer], ["recalls-customer", recallsCustomer], ["keys-old", keysOld], ["sellers-old", sellersOldKeys],
  ["roles", roles], ["outages", outages], ["security", security], ["phone", phone],
];
// A section run on its own (QA_ONLY) starts from what the earlier sections left in the Worker.
ctx.troothId = (await d1("SELECT trooth_id FROM semanto_companies WHERE os_company_id = ?", STACK.companies.acme.os_company_id))[0]?.trooth_id ?? null;
const ran = [];
for (const [name, fn] of sections) {
  if (only && !only.has(name)) continue;
  const t0 = Date.now();
  try {
    await fn(w, ctx);
  } catch (e) {
    w.findings.push(`${name}: the walk stopped: ${String(e?.stack || e).slice(0, 600)}`);
  }
  ran.push({ name, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`section ${name}: ${Math.round((Date.now() - t0) / 1000)}s, findings so far ${w.findings.length}`);
  await writeRecord(w, { sections: ran, partial: true, ctx: { troothId: ctx.troothId, signedVersion: ctx.signedVersion } });
}
const file = await writeRecord(w, { sections: ran, ctx: { troothId: ctx.troothId, signedVersion: ctx.signedVersion } });
await w.close();
console.log(JSON.stringify({ states: w.states.length, findings: w.findings }, null, 1));
console.log(`record: ${file}`);
process.exit(w.findings.length ? 1 : 0);
