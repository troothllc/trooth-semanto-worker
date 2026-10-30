// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The published packages run their own tests: node --test for semanto-mcp
// always, and pytest for the trooth Python package (each framework extra is
// skipped where that framework is not installed).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const has = (mod: string) => spawnSync("python3", ["-c", `import ${mod}`], { encoding: "utf8" }).status === 0;

describe("integrations", () => {
  it("semanto-mcp's tools pass their tests", () => {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "tools.test.mjs"], { cwd: join(ROOT, "integrations/semanto-mcp"), encoding: "utf8" });
    expect(r.stdout).toContain("# fail 0");
    expect(r.status).toBe(0);
  });
  it("the trooth Python package and its framework extras pass their tests where the frameworks are installed", { timeout: 60_000 }, () => {
    if (!has("pytest") || !has("cryptography")) return;
    const r = spawnSync("python3", ["-m", "pytest", "-q", "-p", "no:cacheprovider", "test_integrations.py", "test_client.py"], { cwd: join(ROOT, "verifier/python"), env: { ...process.env, PYTHONPATH: ".", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    expect(r.stdout).toMatch(/\d+ passed/);
    expect(r.status).toBe(0);
  });
});
