// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The browser side of the QA walk (qa/walk/walk.mjs): Playwright Chromium from
// /opt/pw-browsers, as trooth-web's own browser runs use it (scripts/
// qa-semanto-screens.mjs), against the stack qa/stack.mjs brings up. Nothing is
// answered in the browser: every /api request goes to trooth-web's server,
// which calls the real Semanto Worker. Each page and state is screenshotted,
// checked with axe-core (WCAG 2.0, 2.1 and 2.2 A and AA), and every console
// error, page error, failed request and unexpected HTTP error is a finding
// unless the step declared it expected (an unhappy path the screen handles).

import { chromium } from "/home/claude/trooth-web/node_modules/playwright/index.mjs";
import { mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STACK = JSON.parse(readFileSync(new URL("../.run/stack.json", import.meta.url), "utf8"));
export const BASE = STACK.dashboard;
export const CONTROL = STACK.control;
const WEB = "/home/claude/trooth-web";

export async function control(path, body) {
  const r = await fetch(CONTROL + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}
export const d1 = (sql, ...binds) => control("/d1", { db: "semanto", sql, binds });
export const d1f = (sql, ...binds) => control("/d1", { db: "workerf", sql, binds });

function axeSource() {
  const pnpm = join(WEB, "node_modules/.pnpm");
  const dirs = existsSync(pnpm) ? readdirSync(pnpm).filter((d) => d.startsWith("axe-core@")).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(pnpm, d, "node_modules", "axe-core", "axe.min.js");
    if (existsSync(p)) return { source: readFileSync(p, "utf8"), version: d.slice("axe-core@".length) };
  }
  throw new Error("axe-core is not installed under trooth-web/node_modules; refusing to report clean");
}
export const AXE = axeSource();
const CONSENT_VERSION = /CONSENT_VERSION = "([^"]+)"/.exec(readFileSync(join(WEB, "lib/consent.ts"), "utf8"))?.[1];
const EXE = existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined;

/**
 * A walk: one browser, one theme, findings and states collected.
 * expect(pattern) marks HTTP answers of the current step as expected (an unhappy path the screen handles).
 */
export async function startWalk({ theme = "dark", out, runId, viewport = { width: 1568, height: 741 } }) {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(EXE ? { executablePath: EXE } : {}), args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--disable-features=OptimizationHints,MediaRouter,Translate"] });
  const w = {
    theme, out, runId, browser, findings: [], states: [], expected: [], expectedSeen: [], current: "start", contexts: [], requests: [],
    note(f) { this.findings.push(`${this.current}: ${f}`); },
  };
  w.newPage = async (persona, opts = {}) => {
    const context = await browser.newContext({ viewport: opts.viewport ?? viewport, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", acceptDownloads: true });
    const consent = encodeURIComponent(JSON.stringify({ version: CONSENT_VERSION, timestamp: new Date().toISOString(), categories: { necessary: true, analytics: false, marketing: false, functional: false }, receiptId: "qa-receipt" }));
    const cookies = [{ name: "trooth_consent", value: consent, url: BASE }, { name: "trooth-theme", value: theme, url: BASE }];
    if (persona) cookies.push({ name: "trooth_session", value: STACK.personas[persona].token, url: BASE, httpOnly: true });
    await context.addCookies(cookies);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    // The stand-in for Google's consent page: the browser asks accounts.google.com, the upstream double answers.
    await context.route("https://accounts.google.com/**", async (route) => {
      const u = new URL(route.request().url());
      const r = await fetch(`${STACK.upstream}/consent${u.search}`, { method: route.request().method(), headers: { "content-type": "application/x-www-form-urlencoded" }, body: route.request().postData() ?? undefined, redirect: "manual" });
      const headers = Object.fromEntries(r.headers);
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    // Vercel's analytics script is not served by next start; answered empty so it is not a failed request.
    await context.route("**/_vercel/insights/script.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    const page = await context.newPage();
    page.on("pageerror", (e) => w.note(`page error: ${e.message.slice(0, 300)}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      const status = /status of (\d{3})/.exec(t)?.[1];
      if (status && w.isExpected(Number(status), null)) return;
      w.note(`console error: ${t.slice(0, 300)}`);
    });
    let navigatedAt = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigatedAt = Date.now(); });
    // A navigation starting (a reload, a link) cancels the reads in flight before it commits.
    page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigatedAt = Date.now(); });
    page.on("requestfailed", (r) => {
      const u = new URL(r.url());
      if (u.origin !== BASE) return;
      const err = r.failure()?.errorText ?? "";
      // A prefetch or RSC request the browser cancels because the page moved on is not a failure.
      if (err === "net::ERR_ABORTED" && (r.resourceType() === "fetch" && (u.searchParams.has("_rsc") || r.headers()["rsc"] || r.headers()["next-router-prefetch"]))) return;
      if (err === "net::ERR_ABORTED" && r.isNavigationRequest()) return;
      if (err === "net::ERR_ABORTED" && w.allowAbort) return;
      // A read the browser cancels because the page navigated away while it was in flight.
      if (err === "net::ERR_ABORTED" && r.method() === "GET" && Date.now() - navigatedAt < 3000) return;
      // The favicon fetch the browser drops when a navigation it started is cancelled (a leave question answered Cancel).
      if (err === "net::ERR_ABORTED" && u.pathname === "/favicon.ico") return;
      w.note(`request failed: ${r.method()} ${u.pathname}${u.search} ${err}`);
    });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin !== BASE) return;
      w.requests.push({ step: w.current, method: r.request().method(), path: u.pathname + u.search, status: r.status() });
      if (r.status() >= 400) {
        if (w.isExpected(r.status(), u.pathname)) { w.expectedSeen.push({ step: w.current, status: r.status(), path: u.pathname }); return; }
        const step = w.current;
        r.text().then((t) => w.findings.push(`${step}: ${r.status()} on ${r.request().method()} ${u.pathname}${u.search}: ${t.slice(0, 300)}`)).catch(() => w.findings.push(`${step}: ${r.status()} on ${r.request().method()} ${u.pathname}${u.search}`));
      }
    });
    if (opts.passkey) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      page.qaAuthenticator = { cdp, authenticatorId };
    }
    w.contexts.push(context);
    return page;
  };
  w.isExpected = (status, path) => w.expected.some((e) => e.step === w.current && e.status === status && (!path || !e.path || e.path.test(path)));
  w.expect = (status, path = null) => { w.expected.push({ step: w.current, status, path }); };
  w.step = (name) => { w.current = name; };
  w.close = async () => { for (const c of w.contexts) await c.close().catch(() => {}); await browser.close(); };
  return w;
}

export async function axeCheck(w, page, label) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(AXE.source);
  const result = await page.evaluate(async () => {
    // The WCAG A and AA rules, plus Label in Name (2.5.3), which axe ships as experimental and leaves off by default.
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    // Label in Name (2.5.3), which axe ships as experimental and leaves off by default, on everything but the shared
    // account button: its name "Account menu for <name>" holds the visible name; axe also counts the avatar's
    // decorative initial (aria-hidden) as visible text, so the rule cannot pass there by construction.
    const lin = await window.axe.run({ exclude: [['[aria-label^="Account menu for"]']] }, { runOnly: { type: "rule", values: ["label-content-name-mismatch"] }, resultTypes: ["violations"] });
    r.violations.push(...lin.violations);
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)})`) }));
  });
  for (const v of result) w.findings.push(`${label}: axe ${v.id} (${v.impact}): ${v.help} at ${v.nodes.join(" | ")}`);
  return result.length;
}

/** Screenshot, axe, optional keyboard walk; the state is recorded. */
export async function shoot(w, page, name, { axe = true, keys = false } = {}) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const file = `${w.out}/${String(w.states.length + 1).padStart(3, "0")}-${name.replace(/[^a-z0-9-]+/gi, "-")}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const violations = axe ? await axeCheck(w, page, name) : null;
  const kb = keys ? await keyboardWalk(w, page, name) : null;
  w.states.push({ name, url: page.url().replace(BASE, ""), axeViolations: violations, keyboard: kb, file });
  return file;
}

/** Tab through main: every control reached, focus visible on each (scripts/qa-semanto-screens.mjs keyboardWalk). */
export async function keyboardWalk(w, page, label) {
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await page.locator("body").focus();
  const want = await page.evaluate(() => {
    const sel = "main a[href], main button:not([disabled]), main input:not([disabled]):not([type=hidden]), main select:not([disabled]), main textarea:not([disabled]), main summary, main [tabindex]:not([tabindex='-1'])";
    const visible = [...document.querySelectorAll(sel)].filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !el.closest("[inert],[aria-hidden='true']"); });
    const groups = new Set();
    return visible.filter((el) => { if (el.type !== "radio") return true; if (groups.has(el.name)) return false; groups.add(el.name); return true; }).length;
  });
  const seen = new Set();
  const ringed = new Set();
  const noRing = new Map();
  for (let i = 0; i < 500 && seen.size < want; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const inMain = Boolean(el.closest("main"));
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      if (!el.dataset.qaKey) el.dataset.qaKey = Math.random().toString(36).slice(2);
      return { key: el.dataset.qaKey, inMain, ring, what: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}` };
    });
    if (!info) continue;
    if (info.inMain) { seen.add(info.key); if (info.ring) ringed.add(info.key); else noRing.set(info.key, info.what); }
  }
  const invisible = [...noRing].filter(([k]) => !ringed.has(k)).map(([, what]) => what);
  if (seen.size < want) w.findings.push(`${label}: keyboard reached ${seen.size} of ${want} controls`);
  if (invisible.length) w.findings.push(`${label}: ${invisible.length} controls showed no focus ring: ${invisible.slice(0, 6).join("; ")}`);
  return { reached: seen.size, of: want };
}

export async function load(w, page, path, name) {
  w.step(name);
  await page.goto(BASE + path, { waitUntil: "load", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForSelector("main h1", { timeout: 60_000 }).catch(() => w.note("no main h1 appeared"));
  await page.waitForTimeout(400);
}

export async function see(w, page, text, { timeout = 10_000 } = {}) {
  const loc = typeof text === "string" ? page.getByText(text, { exact: false }).first() : page.getByText(text).first();
  const ok = await loc.waitFor({ state: "visible", timeout }).then(() => true, () => false);
  if (!ok) w.note(`expected to see ${text}`);
  return ok;
}

export async function dialogFocus(w, page, trigger, label) {
  await trigger.click();
  const dlg = page.locator("[role='dialog'], [role='alertdialog']").last();
  await dlg.waitFor({ state: "visible", timeout: 10_000 }).catch(() => w.note(`${label}: no dialog opened`));
  await page.waitForTimeout(200);
  const inside = await page.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog'],[role='alertdialog']")));
  if (!inside) w.note(`${label}: the dialog did not take focus`);
  return dlg;
}

export async function writeRecord(w, extra = {}) {
  const file = join(w.out, "walk.json");
  writeFileSync(file, JSON.stringify({ runId: w.runId, theme: w.theme, at: new Date().toISOString(), axe: AXE.version, states: w.states, findings: w.findings, expected: w.expectedSeen, requests: w.requests.length, ...extra }, null, 2));
  return file;
}
