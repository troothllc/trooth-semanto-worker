// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The framework packages under integrations/ run their own tests: node --test
// for semanto-mcp always, and pytest for the Python packages where the
// framework is installed (the packages' own CI installs it).

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
  for (const [dir, mod, file] of [
    ["langchain-semanto", "langchain_core", "test_loader.py"],
    ["llama-index-readers-semanto", "llama_index.core", "test_reader.py"],
    ["openai-agents-semanto", "agents", "test_tool.py"],
  ] as const) {
    it(`${dir} passes its tests where ${mod} is installed`, { timeout: 60_000 }, () => {
      if (!has(mod) || !has("pytest") || !has("cryptography")) return;
      const r = spawnSync("python3", ["-m", "pytest", "-q", "-p", "no:cacheprovider", file], { cwd: join(ROOT, "integrations", dir), env: { ...process.env, PYTHONPATH: `.:${join(ROOT, "verifier/python")}`, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
      expect(r.stdout).toMatch(/\d+ passed/);
      expect(r.status).toBe(0);
    });
  }
});
