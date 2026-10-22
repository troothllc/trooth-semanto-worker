// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Builds the harness page outside the repository (the house-rules scan reads
// every file under web/, and a bundle of React is not ours to scan): esbuild
// bundles entry.js (JSX kept in a .js file so the scan reads it too) with the
// wizard, Tailwind 3 builds the token classes from the wizard's own files,
// and the fonts and an index.html go beside them.
// The output folder is SETUP_HARNESS_OUT, or semanto-setup-harness in the
// system temp folder. Not shipped.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export async function buildHarness(outDir = process.env.SETUP_HARNESS_OUT || join(tmpdir(), "semanto-setup-harness")) {
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  await build({
    entryPoints: [join(here, "entry.js")],
    bundle: true,
    outfile: join(outDir, "app.js"),
    format: "esm",
    jsx: "automatic",
    loader: { ".js": "jsx" },
    target: "es2022",
    nodePaths: [join(here, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    sourcemap: false,
  });
  const tw = spawnSync(process.execPath, [join(here, "node_modules/tailwindcss/lib/cli.js"), "-c", join(here, "tailwind.config.mjs"), "-i", join(here, "harness.css"), "-o", join(outDir, "app.css")], { encoding: "utf8" });
  if (tw.status !== 0) throw new Error(`tailwind failed: ${tw.stderr}`);
  cpSync(join(here, "fonts"), join(outDir, "fonts"), { recursive: true });
  writeFileSync(
    join(outDir, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setting up Semanto</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`,
  );
  return outDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await buildHarness();
  console.log(`built ${out}`);
}
