// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto house rules (docs/ARCHITECTURE.md) across every file of the
// Shopify app, the submission package included: no banned word (the noun a
// ranking gives and the past participles of verify and certify, built here
// from parts as the Worker's own test does), no ellipsis, no X-prefixed
// Trooth header, no representation chosen by User-Agent, and the SPDX and
// copyright header on every code and configuration file. The UI uses Polaris
// web components only: no stylesheet of the app's own and no UI library.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BANNED_WORDS, ELLIPSIS } from "../../../test/helpers/house-rules";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "build", ".react-router", ".wrangler", ".shopify"]);
const files: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = `${d}/${n}`;
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(n)) walk(p);
    } else if (n !== "package-lock.json") files.push(p);
  }
};
walk(root.replace(/\/$/, ""));

describe("house rules across apps/shopify", () => {
  it("finds the app's files", () => {
    expect(files.some((f) => f.endsWith("/shopify.app.toml"))).toBe(true);
    expect(files.some((f) => f.includes("/submission/"))).toBe(true);
  });

  it("no banned word, no ellipsis, no X-prefixed Trooth or Semanto header", () => {
    const xHeader = new RegExp(["X", "(Semanto|Trooth)", ""].join("-"), "i");
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect([f, BANNED_WORDS.test(s)]).toEqual([f, false]);
      expect([f, ELLIPSIS.test(s)]).toEqual([f, false]);
      expect([f, xHeader.test(s)]).toEqual([f, false]);
    }
  });

  it("no code chooses anything by User-Agent", () => {
    for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x) && !x.includes("/test/"))) {
      const s = readFileSync(f, "utf8");
      expect([f, /headers\.get\(\s*["']user-agent["']\s*\)|isbot\(/i.test(s)]).toEqual([f, false]);
    }
  });

  it("every code and configuration file starts with the SPDX and copyright lines", () => {
    for (const f of files.filter((x) => /\.(ts|tsx|sql|toml|liquid)$/.test(x))) {
      const head = readFileSync(f, "utf8").split("\n").slice(0, 4).join("\n");
      expect([f, head.includes("SPDX-License-Identifier: LicenseRef-Trooth-Proprietary") && head.includes("Copyright (c) 2026 Trooth, LLC")]).toEqual([f, true]);
    }
  });

  it("the screens use Polaris web components: no stylesheet and no UI library of the app's own", () => {
    expect(files.filter((f) => /\.(css|scss)$/.test(f))).toEqual([]);
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => /tailwind|polaris$|@shopify\/polaris"|mui|chakra|styled/.test(d))).toEqual([]);
    for (const f of files.filter((x) => x.includes("/app/routes/app") && x.endsWith(".tsx"))) expect([f, /style=\{/.test(readFileSync(f, "utf8"))]).toEqual([f, false]);
  });
});
