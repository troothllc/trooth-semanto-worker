// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// deploy/cloudflare is what the Deploy to Cloudflare button deploys. It must be the adapter sources as they
// are now, self-contained (nothing imported from outside the folder), with TROOTH_ID empty until the owner
// sets it and no route that names someone else's zone.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

describe("deploy/cloudflare", () => {
  it("matches the adapter sources", () => {
    expect(() => execFileSync("node", ["scripts/build-deploy.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
  });
  it("imports nothing from outside its folder", () => {
    for (const f of readdirSync("deploy/cloudflare/src")) expect(readFileSync(`deploy/cloudflare/src/${f}`, "utf8")).not.toMatch(/from\s+["']\.\.\//);
  });
  it("has no route and an empty TROOTH_ID, so a fresh deploy passes every request to the site", () => {
    const toml = readFileSync("deploy/cloudflare/wrangler.toml", "utf8");
    expect(toml).not.toMatch(/^routes\s*=/m);
    expect(toml).toMatch(/^TROOTH_ID = ""$/m);
    const pkg = JSON.parse(readFileSync("deploy/cloudflare/package.json", "utf8"));
    expect(pkg.cloudflare.bindings.TROOTH_ID.description).toMatch(/trooth\.co\/dashboard\/semanto\/install/);
  });
});
