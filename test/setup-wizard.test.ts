// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Unit tests for the setup wizard's pure parts in web/semanto/setup: the
// Website field's cleaning (the same rule as the claim in
// docs/spec/setup-api.md), the poll schedule (4 seconds backing off to 60),
// the install guide chosen by guide_id for every host the spec lists, the
// data client (bearer auth, a deadline, RFC 9457 problems in plain words with
// the request id), and the house rules on every new file. The browser walk is
// a separate script: web/semanto/setup/README.md. And the WorkspaceDomains
// port (src/setup/workspace-domains.ts): the one domain proof is trooth.co's.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSetupClient, SetupApiError } from "../web/semanto/setup/api";
import { cleanDomain } from "../web/semanto/setup/domain";
import { GUIDE_IDS, guideFor, headCode, HOST_CHOICES } from "../web/semanto/setup/guides";
import { POLL_SCHEDULE_MS, pollDelay, stateFingerprint } from "../web/semanto/setup/poll";
import { stepsForHost } from "../web/semanto/setup/dns-guides";
import { BANNED_WORDS, ELLIPSIS } from "./helpers/house-rules";
import { confirmedDomain, confirmedDomains, parseWorkspaceDomains, troothOsWorkspaceDomains, TROOTH_OS_DOMAINS_URL } from "../src/setup/workspace-domains";

describe("the Website field", () => {
  it("keeps the registrable host of a pasted address, as the claim does", () => {
    for (const [input, want] of [
      ["https://www.acme.com/about", "acme.com"],
      ["ACME.com", "acme.com"],
      ["http://acme.com:8080/x?y=1#z", "acme.com"],
      ["www.shop.acme.co.uk/", "shop.acme.co.uk"],
      ["acme.com.", "acme.com"],
    ] as const) {
      const r = cleanDomain(input);
      expect(r.ok && r.domain).toBe(want);
    }
  });
  it("says what is wrong in plain words", () => {
    expect(cleanDomain("")).toMatchObject({ ok: false, empty: true });
    expect(cleanDomain("acme")).toMatchObject({ ok: false, message: "Add the ending, like acme.com." });
    expect(cleanDomain("ac me.com")).toMatchObject({ ok: false });
    expect(cleanDomain("-acme.com")).toMatchObject({ ok: false });
    expect(cleanDomain("acme.c0m")).toMatchObject({ ok: false });
  });
});

describe("the poll", () => {
  it("is every 4 seconds, backing off to 60 (docs/spec/setup-api.md)", () => {
    expect(POLL_SCHEDULE_MS[0]).toBe(4000);
    expect(POLL_SCHEDULE_MS[POLL_SCHEDULE_MS.length - 1]).toBe(60000);
    expect(pollDelay(0)).toBe(4000);
    expect(pollDelay(99)).toBe(60000);
    expect([...POLL_SCHEDULE_MS]).toEqual([...POLL_SCHEDULE_MS].sort((a, b) => a - b));
  });
  it("restarts when something the owner can see changes", () => {
    const base = { step: "prove", saved_for_later: false, proof: { status: "waiting", diagnosis: { state: "looking" } }, read: { status: "reading", pages_done: 10, found: 212 } } as never;
    const moved = { ...(base as object), read: { status: "reading", pages_done: 30, found: 212 } } as never;
    expect(stateFingerprint(base)).not.toBe(stateFingerprint(moved));
    expect(stateFingerprint(base)).toBe(stateFingerprint({ ...(base as object) } as never));
  });
});

describe("the install guide", () => {
  const input = { troothId: "acme", domain: "acme.com", apiBase: "https://api.trooth.co", links: {} };
  it("has a guide for every guide_id the spec lists, with one action and at most four lines", () => {
    for (const [host, id] of Object.entries(GUIDE_IDS)) {
      const g = guideFor(id, input);
      if (host === "unknown") {
        expect(g).toBeNull();
        continue;
      }
      expect(g, id).not.toBeNull();
      expect(g!.lines.length).toBeLessThanOrEqual(4);
      expect(g!.primary.label.length).toBeGreaterThan(0);
    }
  });
  it("uses section 5's action words for the hosts it names", () => {
    const label = (id: string) => guideFor(id, input)!.primary.label;
    expect(label("cloudflare-worker")).toBe("Deploy to Cloudflare");
    expect(label("vercel-middleware")).toBe("Add to Vercel");
    expect(label("netlify-edge")).toBe("Copy the two lines for _redirects");
    expect(label("wordpress-plugin")).toBe("Get the plugin");
    expect(label("shopify-app")).toBe("Install the Shopify app");
    expect(label("webflow-head-code")).toBe("Copy the head code");
    expect(label("squarespace-code-injection")).toBe("Copy the head code");
    expect(label("wix-custom-code")).toBe("Copy the head code");
    expect(label("nginx-config")).toBe("Copy the config");
    expect(label("apache-config")).toBe("Copy the config");
    expect(guideFor("webflow-head-code", input)!.lines).toEqual(["Site settings, Custom code, Head code, Save changes, then Publish."]);
    expect(guideFor("squarespace-code-injection", input)!.lines).toEqual(["Pages, Website Tools, Code Injection, Header, Save."]);
    expect(guideFor("wix-custom-code", input)!.lines).toEqual(["Settings, Custom code, Add code, Head, All pages, Apply."]);
  });
  it("fills the head code from adapters/head-tag with the Trooth ID", () => {
    expect(headCode("https://api.trooth.co/public/semanto/acme")).toBe('<link rel="https://trooth.co/rel/semanto" href="https://api.trooth.co/public/semanto/acme">\n<script type="application/ld+json" src="https://api.trooth.co/public/semanto/acme/facts.jsonld"></script>');
    const adapter = readFileSync(fileURLToPath(new URL("../adapters/head-tag/README.md", import.meta.url)), "utf8");
    expect(adapter).toContain(headCode("https://api.trooth.co/public/semanto/example-inc").split("\n")[0]);
  });
  it("offers every host section 5 lists in the Change list", () => {
    expect(HOST_CHOICES.map((h) => h.label)).toEqual(expect.arrayContaining(["Cloudflare", "Vercel", "Netlify", "WordPress", "Shopify", "Webflow", "Squarespace", "Wix", "nginx", "Apache", "Other"]));
  });
  it("writes the same five DNS steps as src/setup/dns-hosts.ts", () => {
    expect(stepsForHost("godaddy", "_trooth-challenge", "_trooth-challenge.acme.com", "acme.com")[0]).toBe("Open My Products, then your domain, then DNS.");
  });
});

describe("the data client", () => {
  type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
  const fake = (respond: (c: Call) => { status: number; body: unknown; headers?: Record<string, string> } | Promise<never>) => {
    const calls: Call[] = [];
    const fetch = async (url: string, init: Call["init"]) => {
      calls.push({ url, init });
      const r = await respond({ url, init });
      return { ok: r.status < 400, status: r.status, headers: { get: (n: string) => r.headers?.[n] ?? null }, text: async () => JSON.stringify(r.body) };
    };
    return { calls, fetch };
  };

  it("sends the bearer token and the routes of the spec", async () => {
    const f = fake(() => ({ status: 200, body: { object: "semanto.setup" } }));
    const c = createSetupClient({ base: "https://api.trooth.co/", token: () => "tok", fetch: f.fetch });
    await c.state(null);
    await c.state("acme");
    await c.start({ org: "Acme Inc", domain: "https://www.acme.com" });
    await c.choose("acme", "full");
    await c.confirm("acme", { version: 1, root_hash: "sha256:" + "a".repeat(64) });
    await c.host("acme", "webflow");
    await c.installCheck("acme");
    await c.saveForLater("acme", "C");
    await c.passkeyOptions("acme");
    await c.addPasskey("acme", { id: "cred", rawId: "cred", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "oA", transports: ["internal"] } });
    await c.signOptions("acme", { version: 1 });
    await c.sign("acme", { version: 1, assertion: { id: "cred", rawId: "cred", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA", userHandle: null } });
    expect(f.calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      "GET https://api.trooth.co/os/semanto/setup",
      "GET https://api.trooth.co/os/semanto/acme/setup",
      "POST https://api.trooth.co/os/semanto/setup/start",
      "POST https://api.trooth.co/os/semanto/acme/setup/choose",
      "POST https://api.trooth.co/os/semanto/acme/setup/confirm",
      "POST https://api.trooth.co/os/semanto/acme/setup/host",
      "POST https://api.trooth.co/os/semanto/acme/setup/install-check",
      "POST https://api.trooth.co/os/semanto/acme/setup/save-for-later",
      "POST https://api.trooth.co/os/semanto/acme/passkeys/options",
      "POST https://api.trooth.co/os/semanto/acme/passkeys",
      "POST https://api.trooth.co/os/semanto/acme/sign/options",
      "POST https://api.trooth.co/os/semanto/acme/sign",
    ]);
    // The new passkey goes as { credential }; the sign call carries the assertion over the server's challenge.
    expect(JSON.parse(f.calls[9]!.init.body!)).toMatchObject({ credential: { id: "cred", type: "public-key" } });
    expect(JSON.parse(f.calls[11]!.init.body!)).toMatchObject({ version: 1, assertion: { id: "cred", authenticatorData: "AA" } });
    expect(f.calls.every((x) => x.init.headers.Authorization === "Bearer tok")).toBe(true);
    expect(JSON.parse(f.calls[3]!.init.body!)).toEqual({ path: "full" });
    expect(JSON.parse(f.calls[7]!.init.body!)).toEqual({ screen: "C" });
  });

  it("turns a problem into its detail, its next action and the request id", async () => {
    const f = fake(() => ({ status: 500, body: { code: "internal_error", detail: "The step did not finish. Quote request id 0a1b2c3d4e5f6071 to Trooth support.", next_action: "Try again in a minute.", retryable: true } }));
    const c = createSetupClient({ base: "https://api.trooth.co", token: "tok", fetch: f.fetch });
    const e = await c.state("acme").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SetupApiError);
    expect(e).toMatchObject({ status: 500, code: "internal_error", fix: "Try again in a minute.", requestId: "0a1b2c3d4e5f6071" });
    const g = fake(() => ({ status: 409, body: { code: "domain_claimed_elsewhere", detail: "acme.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim." }, headers: { "Trooth-Request-Id": "ffee" } }));
    const e2 = await createSetupClient({ base: "https://x", token: "t", fetch: g.fetch }).start({ org: "a", domain: "acme.com" }).catch((x: unknown) => x);
    expect(e2).toMatchObject({ code: "domain_claimed_elsewhere", requestId: "ffee" });
  });

  it("gives up after its deadline, in plain words", async () => {
    const f = fake(({ init }) => new Promise<never>((_, reject) => (init as unknown as { signal: AbortSignal }).signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const c = createSetupClient({ base: "https://x", token: "t", fetch: f.fetch as never, timeoutMs: 30 });
    const e = await c.state("acme").catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "timeout", detail: "Trooth did not answer within 0 seconds.".replace("0 seconds", `${Math.round(30 / 1000)} seconds`) });
    expect((e as SetupApiError).fix).toBe("Check your connection, then try again. Nothing was lost.");
  });
});

describe("house rules on the wizard's files", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules" && name !== "fonts") walk(p);
      } else files.push(p);
    }
  };
  walk(fileURLToPath(new URL("../web/semanto/setup", import.meta.url)));

  it("every file is scanned: headers, no banned word, no ellipsis", () => {
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      if (f.endsWith("package-lock.json")) continue;
      const s = readFileSync(f, "utf8");
      expect([f, BANNED_WORDS.test(s)]).toEqual([f, false]);
      expect([f, ELLIPSIS.test(s)]).toEqual([f, false]);
      if (/\.(ts|tsx|mjs|js)$/.test(f)) expect([f, s.startsWith("// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary\n// Copyright (c) 2026 Trooth, LLC")]).toEqual([f, true]);
    }
  });

  it("the components never fetch on their own and use blue only through btn-primary", () => {
    for (const f of files.filter((x) => /\/Screen[A-Za-z]+\.tsx$/.test(x))) {
      const s = readFileSync(f, "utf8");
      expect([f, /\bfetch\(/.test(s)]).toEqual([f, false]);
      expect([f, /#1A73E8|bg-blue|text-blue/i.test(s.replace(/focus-visible:outline-\[#1A73E8\]/g, ""))]).toEqual([f, false]);
    }
  });
});

describe("the WorkspaceDomains port: the domains confirmed on trooth.co", () => {
  it("reads worker-f's rows strictly: confirmed needs a date, anything that is not a plain domain is dropped", () => {
    const rows = parseWorkspaceDomains({
      domains: [
        { domain: "Acme.com", status: "confirmed", confirmed_at: "2026-08-03T10:00:00Z", method: "dns" },
        { domain: "acme.io", status: "unconfirmed", confirmed_at: null },
        { domain: "no-date.example", status: "confirmed", confirmed_at: null },
        { domain: "https://bad.example/x", status: "confirmed", confirmed_at: "2026-08-03T10:00:00Z" },
        "acme.net",
      ],
    })!;
    expect(rows).toEqual([
      { domain: "acme.com", status: "confirmed", confirmed_at: "2026-08-03T10:00:00.000Z", method: "dns" },
      { domain: "acme.io", status: "unconfirmed", confirmed_at: null, method: null },
      { domain: "no-date.example", status: "unconfirmed", confirmed_at: null, method: null },
    ]);
    expect(parseWorkspaceDomains({ claims: [] })).toBeNull();
    expect(confirmedDomain(rows, "ACME.com")?.domain).toBe("acme.com");
    expect(confirmedDomain(rows, "acme.io")).toBeNull();
    const two = [...rows, { domain: "older.example", status: "confirmed" as const, confirmed_at: "2026-01-01T00:00:00.000Z", method: "email" }];
    expect(confirmedDomains(two).map((d) => d.domain)).toEqual(["older.example", "acme.com"]);
  });

  it("asks worker-f once per request with the caller's credential, and never reads a failure as no domains", async () => {
    const calls: { url: string; auth: string | null; dpop: string | null }[] = [];
    const answer = { status: 200, body: { domains: [{ domain: "acme.com", status: "confirmed", confirmed_at: "2026-08-03T10:00:00Z" }] } as unknown };
    const service = {
      fetch: async (url: Request | string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        calls.push({ url: String(url), auth: h.get("authorization"), dpop: h.get("dpop") });
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      },
    };
    const port = troothOsWorkspaceDomains(service, { token: "tok", proof: null });
    expect(await port.list()).toMatchObject({ ok: true, domains: [{ domain: "acme.com", status: "confirmed" }] });
    await port.list();
    expect(calls).toEqual([{ url: TROOTH_OS_DOMAINS_URL, auth: "Bearer tok", dpop: null }]);
    expect(TROOTH_OS_DOMAINS_URL).toBe("https://api.trooth.co/auth/domain-claims");
    await troothOsWorkspaceDomains(service, { token: "tok", proof: "a.b.c" }).list();
    expect(calls[1]).toEqual({ url: TROOTH_OS_DOMAINS_URL, auth: "DPoP tok", dpop: "a.b.c" });
    answer.status = 401;
    expect(await troothOsWorkspaceDomains(service, { token: "tok", proof: null }).list()).toEqual({ ok: false, reason: "unauthorized" });
    answer.status = 500;
    expect(await troothOsWorkspaceDomains(service, { token: "tok", proof: null }).list()).toEqual({ ok: false, reason: "unavailable" });
    answer.status = 200;
    answer.body = { nothing: true };
    expect(await troothOsWorkspaceDomains(service, { token: "tok", proof: null }).list()).toEqual({ ok: false, reason: "unavailable" });
    expect(await troothOsWorkspaceDomains(undefined, { token: "tok", proof: null }).list()).toEqual({ ok: false, reason: "unavailable" });
    expect(await troothOsWorkspaceDomains({ fetch: async () => { throw new Error("down"); } }, { token: "tok", proof: null }).list()).toEqual({ ok: false, reason: "unavailable" });
  });
});
