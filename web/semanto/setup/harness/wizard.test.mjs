// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The browser walk of the Semanto setup wizard, in headless Chromium through
// playwright-core, against the mock setup API. It walks every click of the
// full signed path and of the Basic path, asserts section 5's labels on each
// screen (docs/audit/workflow-research.md), that the DNS status changes with
// no click, that every Copy button copies the exact value, that errors give
// the fix in plain words with the request id, that the clicks per screen
// match the counts derived from section 5, one blue button per screen, one
// h1, focus on the heading at each step, aria-live status lines, 44 pixel
// targets and no sideways scroll at 390 pixels, and that polling pauses with
// a hidden tab and keeps the spec's 4 second interval. Screenshots at 1440
// and 390 go to the shots folder passed in.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Clicks per screen, from section 5's controls on the happy path (section 5 names the controls; the counts
 * are the controls a person must press). A: Continue with email, then Save a passkey (or Not now). B:
 * Continue. C by hand: Copy (the value), I've added it; the poll alone moves the screen on, so I've added it
 * is optional and the least is 1. D: Sign it as your company (full) or Finish setup (Basic). E: Confirm
 * these facts, Add a passkey (the first time only: Trooth's options, navigator.credentials.create), Sign with
 * my passkey (Trooth's single-use request for this version, navigator.credentials.get). Each passkey step is
 * its own press because browsers want a fresh user gesture for each WebAuthn ceremony. F: the guide's one
 * action, Check my site, Start monitoring.
 */
export const SECTION5_CLICKS = {
  full: { A: 2, B: 1, C: 2, D: 1, E: 3, F: 3 },
  basic: { B: 1, C: 1, D: 1 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Walk {
  constructor(page, base, shots, name) {
    this.page = page;
    this.base = base;
    this.shots = shots;
    this.name = name;
    this.clicks = {};
    this.log = [];
  }
  async screen() {
    return this.page.locator("[data-wizard]").getAttribute("data-shown");
  }
  /** A counted click: one the owner must make on the happy path. */
  async step(locator, label) {
    const s = await this.screen();
    this.clicks[s] = (this.clicks[s] ?? 0) + 1;
    this.log.push(`${s}: ${label}`);
    await locator.click();
  }
  /** Any other click the walk makes to exercise a control. */
  async explore(locator) {
    await locator.click();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function visible(page, text, opts = {}) {
  const loc = opts.role ? page.getByRole(opts.role, { name: text, exact: opts.exact ?? true }) : page.getByText(text, { exact: opts.exact ?? true });
  try {
    await loc.first().waitFor({ state: "visible", timeout: opts.timeout ?? 6000 });
  } catch {
    const body = await page.locator("body").innerText();
    throw new Error(`Expected to see ${opts.role ? `${opts.role} ` : ""}"${text}". The page reads:\n${body.slice(0, 2500)}`);
  }
  return loc.first();
}

async function waitShown(page, screen, timeout = 8000) {
  await page.locator(`[data-wizard][data-shown="${screen}"]`).waitFor({ timeout });
}

/** The page-wide rules every screen keeps. */
async function screenRules(page, label) {
  // Away from any hover, and past the 150 ms color transition, so the fill read is the resting one.
  await page.mouse.move(0, 0);
  await sleep(220);
  const r = await page.evaluate(() => {
    const vis = (el) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !(b.width <= 1 && b.height <= 1);
    };
    const blue = [...document.querySelectorAll(".btn-primary")].filter(vis).map((e) => e.textContent.trim());
    const blueColor = [...document.querySelectorAll("button, a")].filter(vis).filter((e) => getComputedStyle(e).backgroundColor === "rgb(26, 115, 232)").length;
    const h1 = [...document.querySelectorAll("h1")].filter(vis).map((e) => e.textContent.trim());
    const small = [...document.querySelectorAll("button, a, input:not([type=checkbox]):not([type=radio]), select, textarea, summary")]
      .filter(vis)
      .filter((e) => e.getBoundingClientRect().height < 43.5)
      .map((e) => `${e.tagName} "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${Math.round(e.getBoundingClientRect().height)}px`);
    const statuses = [...document.querySelectorAll('[role="status"]')].every((e) => e.getAttribute("aria-live") === "polite" || e.getAttribute("aria-live") === null);
    const unlabeled = [...document.querySelectorAll("input, select, textarea")].filter(vis).filter((e) => !(e.labels && e.labels.length) && !e.getAttribute("aria-label")).map((e) => e.id || e.name);
    const blueAccent = [...document.querySelectorAll("input[type=checkbox], input[type=radio]")].filter(vis).filter((e) => /rgb\(26, 115, 232\)|auto/.test(getComputedStyle(e).accentColor)).length;
    const text = document.body.innerText;
    return { blueAccent, blue, blueColor, h1, small, statuses, unlabeled, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, text };
  });
  assert(r.blue.length <= 1, `${label}: at most one blue button, found ${JSON.stringify(r.blue)}`);
  assert(r.blueColor === r.blue.length, `${label}: blue fill appears only on btn-primary (${r.blueColor} filled, ${r.blue.length} primary)`);
  assert(r.blueAccent === 0, `${label}: checkboxes and radios are drawn in ink, not blue`);
  assert(r.h1.length === 1, `${label}: one h1, found ${JSON.stringify(r.h1)}`);
  assert(r.small.length === 0, `${label}: every target at least 44px tall, found ${JSON.stringify(r.small)}`);
  assert(r.unlabeled.length === 0, `${label}: every field has a label, found ${JSON.stringify(r.unlabeled)}`);
  assert(r.scrollW <= r.innerW, `${label}: no sideways scroll (${r.scrollW} > ${r.innerW})`);
  assert(!new RegExp(`\\.{3}|${String.fromCharCode(0x2026)}`).test(r.text), `${label}: no ellipsis on screen`);
  const banned = new RegExp(`\\b(${["sc" + "ore", "veri" + "fied", "certi" + "fied"].join("|")})\\b`, "i");
  assert(!banned.test(r.text), `${label}: no banned word on screen`);
  return r;
}

/** The rules first (they wait out hover and transitions), then the picture. */
async function snap(page, path, label) {
  await screenRules(page, label);
  await page.screenshot({ path, fullPage: true });
}

async function shot(walk, name) {
  const { page } = walk;
  const size = page.viewportSize();
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await sleep(120);
    await screenRules(page, `${name} at ${w}`);
    await page.screenshot({ path: join(walk.shots, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize(size);
}

async function copied(page) {
  return page.evaluate(() => window.__copied);
}

async function focusedHeading(page, text) {
  await page.waitForFunction((t) => document.activeElement && document.activeElement.tagName === "H1" && document.activeElement.textContent.trim() === t, text, { timeout: 4000 }).catch(async () => {
    const got = await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent?.trim().slice(0, 60)}`);
    throw new Error(`Focus should be on the heading "${text}", it is on ${got}`);
  });
}

async function control(base, token, body) {
  await fetch(`${base}/__control/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function sessionInfo(base, token) {
  return (await fetch(`${base}/__session/${encodeURIComponent(token)}`)).json();
}

async function newPage(browser, base, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await context.addInitScript(() => {
    const clip = navigator.clipboard;
    if (clip) {
      const orig = clip.writeText.bind(clip);
      clip.writeText = async (t) => {
        window.__copied = t;
        try {
          await orig(t);
        } catch {
          /* the recorded value is what the test reads */
        }
      };
    }
    const creds = navigator.credentials;
    if (creds) {
      const get = creds.get.bind(creds);
      const create = creds.create.bind(creds);
      creds.get = (o) => (window.__failPasskey ? Promise.reject(new DOMException("The person cancelled.", "NotAllowedError")) : get(o));
      creds.create = (o) => (window.__failCreate ? Promise.reject(new DOMException("The person cancelled.", "NotAllowedError")) : create(o));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { context, page, errors };
}

/** The first-time passkey step on Screen E: Trooth's options, the virtual authenticator creates it, Trooth stores it. */
async function addPasskey(page) {
  await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
  await page.getByRole("button", { name: "Sign with my passkey", exact: true }).waitFor({ timeout: 8000 });
}

const LONG_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ------------------------------------------------------------------------------------------- the paths

async function companyStep(walk, site = "https://www.acme.com/about") {
  const { page } = walk;
  await waitShown(page, "B");
  await focusedHeading(page, "Your company");
  await visible(page, "Company name");
  await visible(page, "Website");
  assert((await page.locator("#setup-website").getAttribute("placeholder")) === "example.com", "Website placeholder is example.com");
  await page.fill("#setup-org", "Acme Inc");
  await page.fill("#setup-website", "acme");
  await visible(page, "Add the ending, like acme.com.");
  await page.fill("#setup-website", site);
  await visible(page, "We will use acme.com");
  await visible(page, "Continue", { role: "button" });
}

async function proveStepToProof(walk, token, { pressAdded }) {
  const { page, base } = walk;
  await waitShown(page, "C");
  await focusedHeading(page, "Prove you control acme.com");
  await visible(page, "Add the record. Trooth looks for it on its own.");
  await walk.step(page.getByRole("button", { name: "Copy record value", exact: true }), "Copy record value");
  assert((await copied(page)) === "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef", "Copy copies the exact record value");
  if (pressAdded) await walk.step(page.getByRole("button", { name: "I've added it", exact: true }), "I've added it");
  await control(base, token, { dns: "right" });
  const t0 = Date.now();
  await visible(page, "You proved control of acme.com. Keep the record in place: Trooth looks again every day.", { timeout: 8000 });
  const seenAt = Date.now();
  await waitShown(page, "D", 8000);
  return { proofToRead: Date.now() - seenAt, sinceControl: seenAt - t0 };
}

async function readToDone(walk) {
  const { page } = walk;
  await waitShown(page, "D");
  await focusedHeading(page, "What Semanto read");
  await page.getByText("Found", { exact: true }).waitFor({ timeout: 15000 });
}

export async function fullPath(browser, base, shots) {
  const { page, context, errors } = await newPage(browser, base, 1440);
  const walk = new Walk(page, base, shots, "full");

  // ---- A
  await page.goto(`${base}/`);
  await waitShown(page, "A");
  await focusedHeading(page, "Sign in to Semanto by Trooth");
  await visible(page, "Use your work email so Trooth can match you to your company's domain.");
  const google = await visible(page, "Continue with Google", { role: "link" });
  assert((await google.getAttribute("href")) === "/__guide/google-sign-in", "Continue with Google links into trooth.co sign-in");
  await visible(page, "Work email");
  await shot(walk, "A-sign-in");
  await walk.explore(page.getByRole("button", { name: "Continue with email", exact: true }));
  await visible(page, "Type your work email, like ada@example.com.");
  await page.fill("#setup-work-email", "ada@acme.com");
  await walk.step(page.getByRole("button", { name: "Continue with email", exact: true }), "Continue with email");
  await visible(page, "We sent a sign-in link to ada@acme.com. Open it on this device to continue.");
  const link = await page.evaluate(() => window.__lastLink);
  const token = new URL(link, base).searchParams.get("token");
  // Opening the email is not a click in the wizard.
  await page.goto(`${base}${link}`);
  await waitShown(page, "A");
  await focusedHeading(page, "You are signed in");
  await visible(page, "Not now", { role: "button" });
  await shot(walk, "A-passkey");
  await walk.step(page.getByRole("button", { name: "Save a passkey", exact: true }), "Save a passkey");
  await page.waitForFunction(() => !!window.__passkeySaved, null, { timeout: 8000 });

  // ---- B
  await companyStep(walk);
  await shot(walk, "B-company");
  await walk.step(page.getByRole("button", { name: "Continue", exact: true }), "Continue");

  // ---- C
  await waitShown(page, "C");
  await focusedHeading(page, "Prove you control acme.com");
  await visible(page, "Semanto has started reading your site. Keep going.");
  await visible(page, "Add the record. Trooth looks for it on its own.");
  for (const t of ["Type", "Name", "Value", "TXT", "_trooth-challenge", "Your domain's DNS is at Cloudflare", "Not your host?", "I will do this later"]) await visible(page, t);
  await visible(page, "Some hosts want only _trooth-challenge; others want _trooth-challenge.acme.com. Try the first.");
  await visible(page, "Send these steps to the person who manages our domain", { role: "link" });
  await visible(page, "Add a DNS record", { role: "tab" });
  await shot(walk, "C-prove");
  await walk.explore(page.getByRole("button", { name: "Copy record name", exact: true }));
  assert((await copied(page)) === "_trooth-challenge", "Copy copies the exact record name");
  await visible(page, "Copied", { role: "button", exact: false });
  // The file tab.
  await walk.explore(page.getByRole("tab", { name: "Upload a file instead" }));
  await visible(page, "/.well-known/trooth-claim.txt");
  await walk.explore(page.getByRole("button", { name: "Copy file contents", exact: true }));
  assert((await copied(page)) === "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef", "Copy copies the exact file contents");
  await walk.explore(page.getByRole("button", { name: "Copy file name", exact: true }));
  assert((await copied(page)) === "/.well-known/trooth-claim.txt", "Copy copies the exact file name");
  const dl = await visible(page, "Download the file", { role: "link" });
  assert(decodeURIComponent((await dl.getAttribute("href")).split(",")[1]) === "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef", "Download the file holds the value");
  assert((await dl.getAttribute("download")) === "trooth-claim.txt", "the download is named trooth-claim.txt");
  await walk.explore(page.getByRole("tab", { name: "Add a DNS record" }));
  // Not your host?
  await walk.explore(page.getByText("Not your host?"));
  await page.selectOption("#proof-other-host", "godaddy");
  await visible(page, "Steps for GoDaddy");
  await visible(page, "Open My Products, then your domain, then DNS.");
  await page.selectOption("#proof-other-host", "");
  await visible(page, "Your domain's DNS is at Cloudflare");
  // The two counted clicks.
  await walk.step(page.getByRole("button", { name: "Copy record value", exact: true }), "Copy record value");
  assert((await copied(page)) === "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef", "Copy copies the exact record value");
  await walk.step(page.getByRole("button", { name: "I've added it", exact: true }), "I've added it");
  await visible(page, "Looking for your record");
  assert((await page.getByTestId("record-row-state").getAttribute("data-state")) === "waiting", "the record row starts as not found");
  // The record is added at the DNS host with the wrong value: the screen changes with no click.
  const before = walk.clicks.C;
  await control(base, token, { dns: "wrong" });
  await visible(page, "A record is there, but the value does not match", { timeout: 6000 });
  await visible(page, "Paste the value again using the Copy button, so nothing is retyped.");
  await page.locator('[data-testid="record-row-state"][data-state="wrong"]').waitFor({ timeout: 4000 });
  await visible(page, "Check now", { role: "button" });
  await shot(walk, "C-wrong-value");
  // Fixed at the host: green with no click.
  await control(base, token, { dns: "right" });
  await visible(page, "You proved control of acme.com. Keep the record in place: Trooth looks again every day.", { timeout: 6000 });
  const provedAt = Date.now();
  await page.locator('[data-testid="record-row-state"][data-state="found"]').waitFor({ timeout: 1000 });
  await snap(page, join(shots, "C-proved-1440.png"), "C proved");
  assert(walk.clicks.C === before, "the DNS status changed from waiting to wrong value to proved with no click");
  await waitShown(page, "D", 6000);
  const held = Date.now() - provedAt;
  assert(held >= 1500, `the proved screen stays about two seconds before moving on (stayed ${held} ms)`);

  // ---- D
  await focusedHeading(page, "What Semanto read");
  await visible(page, "Reading your site: 0 of 212 pages. You can close this page. We will email you when it is done.", { timeout: 6000 });
  assert((await page.getByRole("progressbar").getAttribute("aria-valuenow")) === "0", "the bar starts at the real count, 0");
  await control(base, token, { read: "go" });
  // The bar moves on real counts: some value between the first and the last, and its words match it.
  const mid = await page.waitForFunction(() => {
    const el = document.querySelector('[role="progressbar"]');
    const n = el ? Number(el.getAttribute("aria-valuenow")) : 0;
    if (n > 0 && n < 212) return { n, words: document.querySelector('[data-screen="D"] [role="status"]').textContent };
    return null;
  }, null, { timeout: 8000, polling: "raf" });
  const { n: midCount, words } = await mid.jsonValue();
  assert(words === `Reading your site: ${midCount} of 212 pages. You can close this page. We will email you when it is done.`, `the progress words match the bar (${words})`);
  await snap(page, join(shots, "D-reading-1440.png"), "D reading");
  await readToDone(walk);
  for (const [k, v] of [["Found", "212"], ["Read", "206"], ["Left out", "6"]]) {
    const n = await page.locator("dl div").filter({ has: page.getByText(k, { exact: true }) }).locator("dd").innerText();
    assert(n === v, `${k} shows ${v}, got ${n}`);
  }
  const reasons = await page.locator("[data-reason]").evaluateAll((els) => els.map((e) => e.getAttribute("data-reason")));
  assert(JSON.stringify(reasons) === JSON.stringify(["noindex", "robots", "not_found", "login", "duplicate"]), `left-out reasons grouped in section 5's order, got ${reasons}`);
  await visible(page, "Asked search engines not to show it (noindex)");
  await visible(page, "This record is witnessed by Trooth and not signed by the company. Semanto Basic builds it from the public site; the company has not signed it.");
  await visible(page, "Finish setup", { role: "button" });
  await visible(page, "Sign it as your company", { role: "button" });
  await visible(page, "Read again", { role: "button" });
  await walk.explore(page.getByRole("button", { name: "See pages: Asked search engines not to show it (noindex)" }));
  await visible(page, "https://acme.com/staff");
  const open = page.locator("#left-out-noindex").getByRole("link", { name: "Open page" }).first();
  assert((await open.getAttribute("href")) === "https://acme.com/staff", "Open page opens the address");
  await walk.explore(page.getByRole("button", { name: "Copy address https://acme.com/drafts/2025", exact: true }));
  assert((await copied(page)) === "https://acme.com/drafts/2025", "Copy address copies the exact address");
  await shot(walk, "D-receipt");
  await walk.explore(page.getByRole("button", { name: "Hide pages: Asked search engines not to show it (noindex)" }));
  await walk.step(page.getByRole("button", { name: "Sign it as your company", exact: true }), "Sign it as your company");

  // ---- E
  await waitShown(page, "E");
  await focusedHeading(page, "Review and sign");
  for (const t of ["Company", "Products", "Contact and hours", "Policies"]) await visible(page, t, { role: "heading" });
  await visible(page, "Open Monday to Friday, 8 to 6");
  const ticks = await page.getByRole("checkbox", { name: "Looks right" }).evaluateAll((els) => els.map((e) => e.checked));
  assert(ticks.length === 6 && ticks.every(Boolean), "every fact is ticked Looks right by default");
  await visible(page, "From Contact Acme", { role: "link", exact: false });
  await walk.explore(page.getByRole("button", { name: "Fix: Open Monday to Friday, 8 to 6" }));
  await visible(page, "Semanto signs your site's own words, so a wrong fact is fixed on the page it came from. Change it there, then read the site again.");
  await visible(page, "You marked 1 fact to fix. Fix it on your site and read again, or confirm as they are.");
  await shot(walk, "E-review");
  await walk.explore(page.getByRole("button", { name: "Fix: Open Monday to Friday, 8 to 6" }));
  await walk.step(page.getByRole("button", { name: "Confirm these facts", exact: true }), "Confirm these facts");
  await visible(page, "You are signing version 1 of acme.com's Semanto record: 206 pages and 6 facts. Signing says these words came from your company. It does not say they are true; anyone can check who signed.");
  assert(await page.getByRole("radio", { name: "Trooth keeps the key, your passkey releases it" }).isChecked(), "the hosted key is preselected");
  await walk.explore(page.getByRole("radio", { name: "Use our own key" }));
  await visible(page, "Open key settings", { role: "link" });
  assert((await page.getByRole("button", { name: "Sign with my passkey" }).count()) === 0, "with the other key chosen, the passkey button is not offered");
  assert((await page.getByRole("button", { name: "Add a passkey" }).count()) === 0, "with the other key chosen, the add-a-passkey button is not offered");
  await walk.explore(page.getByRole("button", { name: "Keep the current key" }));
  // No passkey on file yet: the one action is to add one (Trooth's options, then the device creates it).
  await visible(page, "Add a passkey", { role: "heading" });
  assert((await page.getByRole("button", { name: "Sign with my passkey" }).count()) === 0, "before a passkey is added, the sign button is not offered");
  await shot(walk, "E-add-passkey");
  await walk.step(page.getByRole("button", { name: "Add a passkey", exact: true }), "Add a passkey");
  await visible(page, "Sign with my passkey", { role: "button", timeout: 8000 });
  await shot(walk, "E-sign");
  await walk.step(page.getByRole("button", { name: "Sign with my passkey", exact: true }), "Sign with my passkey");
  const today = LONG_DATE.format(new Date());
  await visible(page, `Signed by Acme Inc on ${today}. Trooth witnessed the signing.`, { timeout: 8000 });
  const info = await sessionInfo(base, token);
  assert(info.passkeys.length === 1, "the passkey was created on the device from Trooth's options and stored by Trooth");
  assert(info.assertions.length === 1 && info.assertions[0].signature.length > 20, "the passkey step produced a WebAuthn assertion that the sign route checked");
  assert(info.issued.length === 1 && info.assertions[0].challenge === info.issued[0], "the assertion answers the single-use challenge sign/options issued, not a challenge made in the page");
  assert(info.assertions[0].type === "webauthn.get" && info.assertions[0].origin === base, "the assertion is a webauthn.get from this page's origin");
  const order = ["POST /os/semanto/acme/passkeys/options", "POST /os/semanto/acme/passkeys", "POST /os/semanto/acme/sign/options", "POST /os/semanto/acme/sign"].map((r) => info.requests.indexOf(r));
  assert(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), `passkeys/options, passkeys, sign/options, sign were called in that order (${order.join(", ")})`);

  // ---- F
  await waitShown(page, "F", 6000);
  await focusedHeading(page, "Put it on your site");
  await visible(page, "Shopify");
  await visible(page, "Change", { role: "button" });
  const guideBtn = await visible(page, "Install the Shopify app", { role: "link" });
  assert((await guideBtn.getAttribute("class")).includes("btn-primary"), "the guide's action is the blue one before anything is done");
  await visible(page, "Press Save.");
  await visible(page, "Send to my developer", { role: "link" });
  for (const t of ["Your site answers markdown when asked (Accept: text/markdown)", "The signature on what your site sends matches what you signed"]) await visible(page, t);
  const headCode = '<link rel="https://trooth.co/rel/semanto" href="https://api.trooth.co/public/semanto/acme">\n<script type="application/ld+json" src="https://api.trooth.co/public/semanto/acme/facts.jsonld"></script>';
  await walk.explore(page.getByRole("button", { name: "Copy Head code", exact: true }));
  assert((await copied(page)) === headCode, "Copy copies the exact head code");
  await shot(walk, "F-install");

  // Every host the spec lists, through Change: the matching guide by guide_id.
  const hosts = [
    ["Webflow", "Copy the head code", "Site settings, Custom code, Head code, Save changes, then Publish."],
    ["Squarespace", "Copy the head code", "Pages, Website Tools, Code Injection, Header, Save."],
    ["Wix", "Copy the head code", "Settings, Custom code, Add code, Head, All pages, Apply."],
    ["Other", "Copy the head code", "Paste it inside the head of every page, usually in your site's header settings, then publish."],
    ["Cloudflare", "Deploy to Cloudflare", "Pick acme.com and press Deploy."],
    ["Vercel", "Add to Vercel", "It adds middleware.ts and one route handler to your project."],
    ["Netlify", "Copy the two lines for _redirects", "Paste them at the top of the _redirects file in your site's publish folder, then deploy."],
    ["WordPress", "Get the plugin", "Plugins, Add New, Upload, Activate. The plugin connects itself."],
    ["nginx", "Copy the config", "Then run nginx -t and reload nginx."],
    ["Apache", "Copy the config", "Then reload Apache."],
    ["Fastly", "Get the Fastly package", "Run fastly compute publish."],
    ["Akamai", "Get the EdgeWorker bundle", "Upload the bundle and activate it on your property."],
    ["Gcore", "Get the FastEdge app", "Attach the app to your CDN rule."],
    ["Shopify", "Install the Shopify app", "Press Save."],
  ];
  for (const [label, action, line] of hosts) {
    await walk.explore(page.getByRole("button", { name: "Change", exact: true }));
    await walk.explore(page.locator("#host-list").getByRole("button", { name: label, exact: true }));
    await visible(page, line);
    await visible(page, action, { role: action.startsWith("Copy") ? "button" : "link" });
    if (label === "Webflow") await shot(walk, "F-webflow");
    if (label === "Netlify") {
      await walk.explore(page.getByRole("button", { name: "Copy the two lines for _redirects", exact: true }));
      assert((await copied(page)) === "/.well-known/trooth.semanto     https://api.trooth.co/public/semanto/acme            200!\n/.well-known/trooth-keys.json   https://api.trooth.co/public/semanto/acme/keys.json  200!", "Copy copies the exact _redirects lines");
    }
    if (label === "Cloudflare") {
      await walk.explore(page.getByRole("button", { name: "Copy TROOTH_ID", exact: true }));
      assert((await copied(page)) === "acme", "Copy copies the exact Trooth ID");
      await walk.explore(page.getByRole("button", { name: "Copy TROOTH_API_BASE", exact: true }));
      assert((await copied(page)) === "https://api.trooth.co", "Copy copies the exact API base");
    }
  }
  const hostInfo = await sessionInfo(base, token);
  assert(hostInfo.host === "shopify", "the host choice was saved through setup/host");

  // The counted install: the guide's action (it opens a new tab), then Check my site.
  const [popup] = await Promise.all([context.waitForEvent("page"), walk.step(page.getByRole("link", { name: "Install the Shopify app" }), "Install the Shopify app")]);
  await popup.close();
  const checkBtn = await visible(page, "Check my site", { role: "button" });
  assert((await checkBtn.getAttribute("class")).includes("btn-primary"), "after the guide's action, Check my site is the blue one");
  await screenRules(page, "F after the guide");
  await walk.step(checkBtn, "Check my site");
  await visible(page, "Your site answers in markdown and the signature checks out.", { timeout: 6000 });
  for (const k of ["markdown", "signature", "well_known"]) assert((await page.locator(`[data-check="${k}"]`).getAttribute("data-state")) === "pass", `check ${k} passed`);
  // The API's pass message repeats the label, so the row says the state in a word instead of saying it twice.
  assert((await page.locator('[data-check="signature"]').innerText()) === "The signature on what your site sends matches what you signed\nPassed.", "the signature check reads as passed, once");
  await visible(page, "Questions Semanto will ask AI assistants about you", { role: "heading" });
  await visible(page, "Companies to compare", { role: "heading" });
  await visible(page, "Check again", { role: "button" });
  await walk.explore(page.getByRole("button", { name: "Remove question: Where is Acme Inc based?" }));
  await page.fill("#setup-new-question", "Does Acme Inc ship to Canada?");
  await walk.explore(page.getByRole("button", { name: "Add a question" }));
  await visible(page, "Does Acme Inc ship to Canada?");
  await page.fill("#setup-company-name", "Globex");
  await page.fill("#setup-company-site", "globex");
  await walk.explore(page.getByRole("button", { name: "Add a company" }));
  await visible(page, "Add the ending, like globex.com.");
  await page.fill("#setup-company-site", "https://www.globex.com/");
  await walk.explore(page.getByRole("button", { name: "Add a company" }));
  await visible(page, "globex.com");
  await shot(walk, "F-monitoring");
  await walk.step(page.getByRole("button", { name: "Start monitoring", exact: true }), "Start monitoring");
  await visible(page, "acme.com is serving your signed Semanto record.", { timeout: 6000 });
  const mon = (await sessionInfo(base, token)).monitoring;
  assert(JSON.stringify(mon.questions) === JSON.stringify(["What does Acme Inc do?", "What are Acme Inc's opening hours?", "How much does Acme Inc charge for delivery?", "Does Acme Inc ship to Canada?"]), "the questions sent are the ones on screen");
  assert(JSON.stringify(mon.competitors) === JSON.stringify([{ name: "Globex", domain: "globex.com" }]), "the companies sent are the ones on screen");
  const openMon = await visible(page, "Open monitoring", { role: "link" });
  assert((await openMon.getAttribute("href")) === "/__guide/monitoring", "the done state links to monitoring");
  assert((await page.getByTestId("step-line").innerText()) === "Setup is finished", "the tracker says setup is finished");
  await shot(walk, "F-done");

  assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
  await context.close();
  return walk;
}

export async function basicPath(browser, base, shots) {
  const token = `basic-${Date.now().toString(36)}`;
  const { page, context, errors } = await newPage(browser, base, 390);
  const walk = new Walk(page, base, shots, "basic");
  await page.goto(`${base}/?token=${token}`);
  await companyStep(walk);
  await snap(page, join(shots, "basic-B-390.png"), "basic B at 390");
  // Keyboard only: Tab to Continue and press Enter.
  await page.locator("#setup-website").focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  assert(focused === "Continue", `Tab from Website reaches Continue, got ${focused}`);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert(ring === "solid", `a visible focus ring on the focused button, got outline ${ring}`);
  walk.clicks.B = (walk.clicks.B ?? 0) + 1;
  walk.log.push("B: Continue (Enter key)");
  await page.keyboard.press("Enter");
  await waitShown(page, "C");
  await snap(page, join(shots, "basic-C-390.png"), "basic C at 390");
  // Copy, then the record is added at the host; the poll moves the screen on with no further click.
  await proveStepToProof(walk, token, { pressAdded: false });
  await readToDone(walk);
  await snap(page, join(shots, "basic-D-390.png"), "basic D at 390");
  await walk.step(page.getByRole("button", { name: "Finish setup", exact: true }), "Finish setup");
  await visible(page, "Semanto Basic is set up for acme.com. Trooth witnessed what it read, and looks again every day.");
  assert((await page.getByTestId("step-line").innerText()) === "Semanto Basic is set up", "the tracker says Basic is set up");
  const skipped = await page.locator('[data-step-state="skipped"]').count();
  assert(skipped === 2, `Review and sign and Put it on your site are marked not in Basic, got ${skipped}`);
  await visible(page, "Sign it as your company", { role: "button" });
  await snap(page, join(shots, "basic-done-390.png"), "basic done at 390");
  assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
  await context.close();
  return walk;
}

/** To Screen E (signing) for a scenario: B, C, D and the review confirm. */
async function toSign(page, base, token, { confirm = true } = {}) {
  await page.goto(`${base}/?token=${token}`);
  await waitShown(page, "B");
  await page.fill("#setup-org", "Acme Inc");
  await page.fill("#setup-website", "acme.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitShown(page, "C");
  await control(base, token, { dns: "right" });
  await waitShown(page, "D", 8000);
  await page.getByRole("button", { name: "Sign it as your company" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Sign it as your company" }).click();
  await waitShown(page, "E");
  if (confirm) {
    await page.getByRole("button", { name: "Confirm these facts" }).click();
    await page.getByText("You are signing version 1", { exact: false }).waitFor();
  }
}

export async function errorPaths(browser, base, shots) {
  const results = [];
  // ---- B errors, save for later, partial read, confirm conflict, passkey cancel, failed check.
  {
    const token = `errors-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 1440);
    await page.goto(`${base}/?token=${token}`);
    await waitShown(page, "B");
    await page.fill("#setup-org", "Acme Inc");
    await page.fill("#setup-website", "taken.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await visible(page, "taken.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim.");
    await page.fill("#setup-website", "boom.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await visible(page, "The step did not finish. Quote request id 0a1b2c3d4e5f6071 to Trooth support.");
    await visible(page, "Try again in a minute. If it keeps happening, quote the request id to Trooth support.");
    await visible(page, "0a1b2c3d4e5f6071");
    await snap(page, join(shots, "errors-B-1440.png"), "errors B");
    await page.fill("#setup-website", "acme.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await waitShown(page, "C");
    // Save for later, then pick up.
    await page.getByRole("button", { name: "Save for later" }).click();
    await visible(page, "Saved for later. You can close this page; every email from Trooth links back to this step.");
    assert((await sessionInfo(base, token)).savedScreen === "C", "Save for later sends the screen");
    await page.getByRole("button", { name: "Pick up where you left off" }).click();
    await page.getByText("Saved for later.", { exact: false }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "I will do this later" }).click();
    await visible(page, "Saved. You can close this page. Trooth keeps looking for 72 hours and emails you when it finds the record.");
    await page.getByRole("button", { name: "Pick up where you left off" }).click();
    await control(base, token, { dns: "right" });
    await waitShown(page, "D", 8000);
    // A partial read is a partial receipt, never finished.
    await visible(page, "Stopped at 120 of 212 pages.", { exact: false, timeout: 15000 });
    await visible(page, "Continue reading", { role: "button" });
    assert((await page.getByRole("button", { name: "Finish setup" }).count()) === 0, "a partial read offers no Finish setup");
    await snap(page, join(shots, "errors-D-partial-1440.png"), "errors D partial");
    await page.getByRole("button", { name: "Continue reading" }).click();
    await page.getByRole("button", { name: "Sign it as your company" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Sign it as your company" }).click();
    await waitShown(page, "E");
    await page.getByRole("button", { name: "Confirm these facts" }).waitFor();
    await page.getByText("Open Monday to Friday, 8 to 6").waitFor();
    await page.getByRole("button", { name: "Confirm these facts" }).click();
    await visible(page, "This version changed while you were reviewing. Review the changes, then confirm.");
    await snap(page, join(shots, "errors-E-changed-1440.png"), "errors E changed");
    await page.getByRole("button", { name: "Confirm these facts" }).click();
    await page.getByText("You are signing version 1", { exact: false }).waitFor();
    // Adding the passkey is cancelled on the device, then done.
    await page.evaluate(() => (window.__failCreate = true));
    await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
    await visible(page, "Your device did not finish adding the passkey. Nothing was saved. Try again.");
    await page.evaluate(() => (window.__failCreate = false));
    await addPasskey(page);
    // The passkey step is cancelled on the device.
    await page.evaluate(() => (window.__failPasskey = true));
    await page.getByRole("button", { name: "Sign with my passkey" }).click();
    await visible(page, "Your device did not finish the passkey step. Nothing was signed. Try again.");
    await snap(page, join(shots, "errors-E-passkey-1440.png"), "errors E passkey");
    await page.evaluate(() => (window.__failPasskey = false));
    await page.getByRole("button", { name: "Sign with my passkey" }).click();
    await waitShown(page, "F", 10000);
    await page.getByRole("button", { name: "Check my site" }).click();
    await page.locator('[data-check="markdown"][data-state="fail"]').waitFor({ timeout: 6000 });
    assert((await page.locator('[data-check="markdown"]').innerText()).includes("Your site sent a web page, not markdown. The app or code is not live yet. On Webflow and Squarespace, publish the site; on WordPress, clear the cache; then check again."), "the failed markdown check gives the API's fix");
    assert((await page.locator('[data-check="markdown"]').getAttribute("data-state")) === "fail", "the failed check shows as failed");
    assert((await page.locator('[data-check="well_known"]').innerText()).includes("Your site does not serve /.well-known/trooth.semanto and /.well-known/trooth-keys.json yet. The app or code serves both; check that it is live."), "the failed well-known check gives the API's fix");
    const again = await visible(page, "Check again", { role: "button" });
    assert((await again.getAttribute("class")).includes("btn-primary"), "after a failed check, Check again is the one blue action");
    await snap(page, join(shots, "errors-F-check-1440.png"), "errors F check");
    await again.click();
    await visible(page, "Your site answers in markdown and the signature checks out.", { timeout: 6000 });
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("errors");
  }
  // ---- Customer custody: the exact signing input, a bad signature, then a good one.
  {
    const token = `customer-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 1440);
    await toSign(page, base, token);
    const input = await page.getByTestId("signing-input").innerText();
    assert(input === "eyJhbGciOiJFZERTQSIsImtpZCI6ImZpeHR1cmUtY3VzdG9tZXIta2lkLTEifQ.eyJ2ZXJzaW9uIjoxLCJyb290X2hhc2giOiJmaXh0dXJlIn0", "the signing input is shown exactly");
    await page.getByRole("button", { name: "Copy signing input" }).click();
    assert((await copied(page)) === input, "Copy copies the exact signing input");
    assert(await page.getByRole("radio", { name: "Use our own key" }).isChecked(), "customer custody preselects our own key");
    await page.fill("#setup-signature", "short");
    await page.getByRole("button", { name: "Send the signature" }).click();
    await visible(page, "Paste the 64-byte Ed25519 signature in base64url: 86 characters of letters, digits, - and _.");
    await page.fill("#setup-signature", "A".repeat(86));
    await page.getByRole("button", { name: "Send the signature" }).click();
    await visible(page, "The signature did not check out: it was not made by key fixture-customer-kid-1 over this signing input.");
    await visible(page, "Sign the signing input shown, with the private key for fixture-customer-kid-1, and paste the new signature.");
    await snap(page, join(shots, "customer-E-1440.png"), "customer E");
    await page.setViewportSize({ width: 390, height: 844 });
    await snap(page, join(shots, "customer-E-390.png"), "customer E at 390");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.fill("#setup-signature", "B".repeat(86));
    await page.getByRole("button", { name: "Send the signature" }).click();
    await waitShown(page, "F", 10000);
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("customer");
  }
  // ---- Two officers: the approvals list and the waiting words.
  {
    const token = `officer-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 1440);
    await toSign(page, base, token);
    await visible(page, "Approvals", { role: "heading" });
    await visible(page, "Two officers of Acme Inc approve this version before it is signed. 0 of 2 so far.");
    await addPasskey(page);
    await page.getByRole("button", { name: "Sign with my passkey" }).click();
    await visible(page, "Two officers must approve this version. One has.", { timeout: 8000 });
    await visible(page, "A second officer needs their own Trooth account to approve. Invite them from Team settings.");
    await visible(page, "Two officers of Acme Inc approve this version before it is signed. 1 of 2 so far.", { timeout: 6000 });
    await visible(page, "ada@acme.com", { exact: false });
    await snap(page, join(shots, "officer-E-1440.png"), "officer E");
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("officer");
  }
  // ---- Domain Connect: the one-click layout, the manual switch, and a cancelled return.
  {
    const token = `dc-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 1440);
    await page.goto(`${base}/?token=${token}`);
    await waitShown(page, "B");
    await page.fill("#setup-org", "Acme Inc");
    await page.fill("#setup-website", "acme.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await waitShown(page, "C");
    await visible(page, "Your domain's DNS is at Cloudflare. Trooth can add the record for you. You will sign in at Cloudflare and approve two records. Nothing else changes.");
    const add = await visible(page, "Add it at Cloudflare", { role: "link" });
    assert((await add.getAttribute("href")) === "/__guide/domain-connect?domain=acme.com", "Add it at Cloudflare opens the API's domain_connect_url");
    await visible(page, "Send these steps to the person who manages our domain", { role: "link" });
    await snap(page, join(shots, "dc-C-1440.png"), "dc C");
    await page.getByRole("button", { name: "I'll add it myself" }).click();
    await visible(page, "I've added it", { role: "button" });
    await visible(page, "Use one click at Cloudflare instead", { role: "button" });
    await screenRules(page, "dc C manual");
    await page.goto(`${base}/?token=${token}&theme=dark`);
    await visible(page, "Add it at Cloudflare", { role: "link" });
    await snap(page, join(shots, "dark-C-1440.png"), "dc C dark");
    await page.goto(`${base}/?token=${token}&declined=1`);
    await visible(page, "You cancelled at Cloudflare. Nothing was changed. Try again, or add it yourself.");
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("domain connect");
  }
  // ---- 72 hours: Look again.
  {
    const token = `timeout-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 1440);
    await page.goto(`${base}/?token=${token}`);
    await waitShown(page, "B");
    await page.fill("#setup-org", "Acme Inc");
    await page.fill("#setup-website", "acme.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await waitShown(page, "C");
    await visible(page, "Trooth stopped looking after 72 hours", { timeout: 6000 });
    await visible(page, "Check the record with your DNS host, then press Look again.");
    await screenRules(page, "timeout C");
    await page.getByRole("button", { name: "Look again" }).click();
    await visible(page, "Looking for your record", { timeout: 6000 });
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("timeout");
  }
  // ---- No host detected: the list opens, and a pick shows its guide.
  {
    const token = `unknownhost-${Date.now().toString(36)}`;
    const { page, context, errors } = await newPage(browser, base, 390);
    await toSign(page, base, token);
    await addPasskey(page);
    await page.getByRole("button", { name: "Sign with my passkey" }).click();
    await waitShown(page, "F", 10000);
    await visible(page, "We could not tell where your site runs. Pick it from the list.");
    await snap(page, join(shots, "unknownhost-F-390.png"), "unknown host F at 390");
    await page.locator("#host-list").getByRole("button", { name: "Wix", exact: true }).click();
    await visible(page, "Settings, Custom code, Add code, Head, All pages, Apply.");
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("unknown host");
  }
  // ---- Sign-in errors: an expired link, a send that failed, a passkey the device would not save.
  {
    const { page, context, errors } = await newPage(browser, base, 390);
    await page.goto(`${base}/?expired=ada%40acme.com`);
    await visible(page, "That link has expired. We sent a new one to ada@acme.com.");
    await page.fill("#setup-work-email", "fail@acme.com");
    await page.getByRole("button", { name: "Continue with email" }).click();
    await visible(page, "The sign-in link was not sent. Check your connection, then try again.");
    await snap(page, join(shots, "errors-A-390.png"), "errors A at 390");
    await page.goto(`${base}/?token=full-nopasskey-${Date.now().toString(36)}&fresh=1`);
    await page.evaluate(() => {
      navigator.credentials.create = () => Promise.reject(new DOMException("no", "NotAllowedError"));
    });
    await page.getByRole("button", { name: "Save a passkey" }).click();
    await visible(page, "Your device did not save the passkey. You can sign in with your email link every time, or try again later in Settings.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await waitShown(page, "B");
    assert(errors.length === 0, `no page errors: ${errors.join("; ")}`);
    await context.close();
    results.push("sign-in");
  }
  return results;
}

/** Polling: the spec's schedule, paused while the tab is hidden, read again on return. */
export async function pollingChecks(browser, base) {
  const out = {};
  {
    const token = `full-poll-${Date.now().toString(36)}`;
    const { page, context } = await newPage(browser, base, 1440);
    await page.goto(`${base}/?token=${token}`);
    await waitShown(page, "B");
    await page.fill("#setup-org", "Acme Inc");
    await page.fill("#setup-website", "acme.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await waitShown(page, "C");
    await sleep(600);
    const gets = async () => (await (await fetch(`${base}/__stats?token=${token}`)).json()).gets;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(300);
    const hiddenStart = (await gets()).length;
    await sleep(2000);
    const hiddenEnd = (await gets()).length;
    assert(hiddenEnd - hiddenStart === 0, `no reads while the tab is hidden (got ${hiddenEnd - hiddenStart} in 2 seconds)`);
    const t = Date.now();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(400);
    const after = (await gets()).filter((g) => g >= t).length;
    assert(after >= 1, "a read happens at once when the tab comes back");
    // Focus also brings a read.
    const t2 = Date.now();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(400);
    assert((await gets()).filter((g) => g >= t2).length >= 1, "a read happens when the window regains focus");
    out.hidden = { readsWhileHidden: hiddenEnd - hiddenStart, readsOnReturn: after };
    await context.close();
  }
  {
    // The spec's schedule: a read on arrival, the next about 4 seconds later.
    const token = `full-spec-${Date.now().toString(36)}`;
    const { page, context } = await newPage(browser, base, 1440);
    await page.goto(`${base}/?token=${token}&poll=spec`);
    await waitShown(page, "B");
    const t0 = Date.now();
    await sleep(4700);
    const gets = (await (await fetch(`${base}/__stats?token=${token}`)).json()).gets.map((g) => g - t0);
    const gaps = gets.slice(1).map((g, i) => g - gets[i]);
    assert(gets.length === 2 && gaps[0] >= 3800 && gaps[0] <= 4600, `with the spec's schedule the second read comes about 4 seconds after the first, got ${JSON.stringify(gets)}`);
    out.spec = { readsIn4700ms: gets.length, gapMs: gaps[0] };
    await context.close();
  }
  return out;
}

export async function runAll({ browser, base, shots }) {
  mkdirSync(shots, { recursive: true });
  const t0 = Date.now();
  const full = await fullPath(browser, base, shots);
  const basic = await basicPath(browser, base, shots);
  for (const [name, walk] of [["full", full], ["basic", basic]]) {
    const want = SECTION5_CLICKS[name];
    for (const [screen, n] of Object.entries(want)) assert((walk.clicks[screen] ?? 0) === n, `${name} path, screen ${screen}: ${n} click(s) per section 5, counted ${walk.clicks[screen] ?? 0} (${walk.log.join(", ")})`);
    for (const screen of Object.keys(walk.clicks)) assert(screen in want, `${name} path: unexpected counted click on screen ${screen}`);
  }
  const errors = await errorPaths(browser, base, shots);
  const polling = await pollingChecks(browser, base);
  return { ms: Date.now() - t0, clicks: { full: full.clicks, basic: basic.clicks }, log: { full: full.log, basic: basic.log }, errors, polling };
}
