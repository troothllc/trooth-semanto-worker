// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The install check on a host where Semanto is the head code (src/setup/install-check.ts): it reads the home page's
// head for the Semanto link, as Google Search Console's HTML tag method does, instead of three checks a head tag can
// never pass.

import { describe, it, expect } from "vitest";
import { runInstallCheck, semantoLinkHref, INSTALL_OK_HEAD } from "@/setup/install-check";

const page = (html: string, status = 200) => ({ status, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) });
const input = { domain: "acme.com", homePageHash: null, pageHashes: [], networkCopy: { semanto: new Uint8Array(), keys: new Uint8Array() }, resolveKey: () => null, now: new Date("2026-10-30T12:00:00Z"), headCode: { troothId: "acme" } };

describe("the head code install check", () => {
  it("passes when the home page links to the company's signed copy", async () => {
    const r = await runInstallCheck(input, { fetch: async () => page('<html><head><link rel="https://trooth.co/rel/semanto" href="https://api.trooth.co/public/semanto/acme"></head></html>') });
    expect(r.checks).toEqual({ markdown: "pass", signature: "pass", well_known: "pass" });
    expect(r.message).toBe(INSTALL_OK_HEAD);
  });
  it("says the link is missing, and names another company's link", async () => {
    const missing = await runInstallCheck(input, { fetch: async () => page("<html><head></head></html>") });
    expect(missing.checks.markdown).toBe("fail");
    expect(missing.message).toMatch(/does not carry the Semanto link/);
    const other = await runInstallCheck(input, { fetch: async () => page("<link href='https://api.trooth.co/public/semanto/globex' rel='https://trooth.co/rel/semanto'>") });
    expect(other.checks).toMatchObject({ markdown: "pass", signature: "fail" });
  });
  it("reads the href whatever the attribute order and quotes", () => {
    expect(semantoLinkHref("<LINK href=https://x/y rel=https://trooth.co/rel/semanto>")).toBe("https://x/y");
    expect(semantoLinkHref('<link rel="stylesheet" href="/a.css">')).toBeNull();
  });
});
