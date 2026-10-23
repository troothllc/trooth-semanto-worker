// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: 1c Read receipts. Real reads first (qa/reads.mts: unsigned readers and
// two agents signing with Web Bot Auth), counted by the Worker's RateLimitDO and
// written to D1 once a minute; then 60 earlier days of rows put in D1 so the
// table has more than one page. Every filter, the presets, the invalid ranges,
// Previous and Next, Reset, Back, and Download CSV compared with the table.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load, shoot, see, d1, control } from "./lib.mjs";

export async function receipts(w, ctx) {
  w.step("receipts-reads");
  const r = spawnSync("npx", ["tsx", "qa/reads.mts", ctx.troothId], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" });
  if (r.status !== 0) w.note(`the reads script failed: ${(r.stderr || r.stdout).slice(-400)}`);
  const made = JSON.parse((r.stdout.trim().split("\n").pop() || "{}"));
  if (!made.signed) w.note(`no signed agent read was accepted (${r.stdout.trim()})`);
  // The RateLimitDO writes the minute's counts to D1 once a minute.
  let signedRows = [];
  for (let i = 0; i < 30 && !signedRows.length; i++) {
    await new Promise((ok) => setTimeout(ok, 5000));
    signedRows = await d1("SELECT id FROM semanto_read_receipts WHERE trooth_id = ? AND proof = 'web_bot_auth'", ctx.troothId);
  }
  if (!signedRows.length) w.note("the signed reads never reached D1");
  const pages = await d1("SELECT DISTINCT page_id FROM semanto_read_receipts WHERE trooth_id = ? AND page_id IS NOT NULL", ctx.troothId);
  for (let i = 1; i <= 60; i++) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    await d1("INSERT INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash, count, minute) VALUES (?, ?, 1, ?, 'markdown', NULL, NULL, 'none', ?, NULL, ?, ?)", `smd_qa_seed_${i}`, ctx.troothId, pages[i % Math.max(1, pages.length)]?.page_id ?? null, `${day}T12:00:00.000Z`, (i % 7) + 1, `${day}T12:00`);
  }

  const page = ctx.ownerPage ?? (ctx.ownerPage = await w.newPage("owner", { passkey: true }));
  await load(w, page, "/dashboard/semanto/receipts", "receipts");
  await see(w, page, "Who read your signed record");
  await page.getByRole("table").waitFor({ timeout: 15_000 }).catch(() => w.note("no receipts table for the last seven days"));
  if (!(await page.getByRole("table").getByText("Unsigned reader").count())) w.note("no unsigned reads in the table");
  await shoot(w, page, "receipts", { keys: true });

  // Status filter: signed agents only.
  w.step("receipts-signed");
  await page.getByLabel("Signed or unsigned").selectOption("signed_agent");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForTimeout(1200);
  if (!/status=signed_agent/.test(page.url())) w.note("the status filter is not in the address");
  const unsignedLeft = await page.getByRole("table").getByText("Unsigned reader").count();
  if (unsignedLeft) w.note("unsigned rows are listed under Signed agents");
  const agentOptions = await page.getByLabel("Agent").locator("option").allInnerTexts();
  if (agentOptions.length < 3) w.note(`the agent list has ${agentOptions.length} options; two signing agents read`);
  await shoot(w, page, "receipts-signed-agents");
  // Agent filter on one agent.
  w.step("receipts-agent");
  const oneAgent = agentOptions.find((o) => /qa-agent-one/.test(o));
  if (oneAgent) {
    await page.getByLabel("Agent").selectOption({ label: oneAgent });
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForTimeout(1200);
    if (await page.getByRole("table").getByText(/qa-agent-two/).count()) w.note("another agent's rows show under the agent filter");
    await shoot(w, page, "receipts-agent");
  } else w.note("the first signing agent is not in the agent list");
  // Path prefix: the whole file.
  w.step("receipts-path");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(800);
  await page.getByLabel("Page starts with").fill("(whole file)");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForTimeout(1200);
  const tableText = await page.getByRole("table").innerText().catch(() => "");
  if (!/The whole signed file/.test(tableText)) w.note("the whole-file filter shows no whole-file reads");
  await shoot(w, page, "receipts-path");

  // Invalid ranges: the last day before the first, more than 92 days, an empty day.
  w.step("receipts-invalid");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(600);
  await page.getByLabel("From", { exact: true }).fill("2026-10-20");
  await page.getByLabel("To", { exact: true }).fill("2026-10-10");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await see(w, page, "The first day must not be after the last day.");
  await shoot(w, page, "receipts-invalid-order");
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).fill("2026-10-20");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await see(w, page, "Choose at most 92 days at a time.");
  await page.getByLabel("From", { exact: true }).fill("");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await see(w, page, "Enter both days as dates.");
  await shoot(w, page, "receipts-invalid-empty");

  // The 90-day preset: more than one page; Next and Previous; Back undoes the preset.
  w.step("receipts-pages");
  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Last 90 days" }).click();
  await page.waitForTimeout(1500);
  const first = await page.getByRole("table").locator("tbody tr").count();
  if (first !== 50) w.note(`the first page of 90 days has ${first} rows, not 50`);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForTimeout(1500);
  const second = await page.getByRole("table").locator("tbody tr").count();
  if (second < 1) w.note("Next showed no rows");
  await shoot(w, page, "receipts-page-2", { keys: true });
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.waitForTimeout(1200);
  if ((await page.getByRole("table").locator("tbody tr").count()) !== first) w.note("Previous did not come back to the first page");
  const presetUrl = page.url();
  await page.goBack();
  await page.waitForTimeout(1200);
  if (page.url() === presetUrl) w.note("Back did not undo the preset");

  // Download CSV of the 90 days: the header fixed, every row of every page.
  w.step("receipts-csv");
  await page.goto(presetUrl);
  await page.getByRole("table").waitFor({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.getByRole("button", { name: "Download CSV" }).click()]);
  const csv = readFileSync(await download.path(), "utf8").trim().split(/\r?\n/); // RFC 4180 lines end in CRLF
  if (csv[0] !== "day,agent,operator,path,reads,signed,last_at") w.note(`the CSV header is ${csv[0]}`);
  const api = await control("/worker/fetch", { path: `/os/semanto/${ctx.troothId}/receipts?${new URL(presetUrl).search.slice(1)}&limit=200`, headers: { authorization: "Bearer qa-token-owner-acme" } });
  const rows = JSON.parse(api.text).rows ?? [];
  if (csv.length - 1 !== rows.length) w.note(`the CSV has ${csv.length - 1} rows, the filters have ${rows.length}`);
  if (!/\.csv$/.test(download.suggestedFilename())) w.note(`the CSV file name is ${download.suggestedFilename()}`);
  // Empty: a range with no reads.
  w.step("receipts-empty");
  await page.goto(`${new URL(presetUrl).origin}/dashboard/semanto/receipts?from=2025-01-01&to=2025-01-31`);
  await see(w, page, "No reads for these filters");
  const dl = page.getByRole("button", { name: "Download CSV" });
  if ((await dl.count()) && (await dl.isEnabled())) w.note("Download CSV is on with no reads");
  await shoot(w, page, "receipts-empty");
}
