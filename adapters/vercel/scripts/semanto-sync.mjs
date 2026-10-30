// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Build step for the Vercel adapter. Vercel reserves /.well-known for rewrites
// and redirects (vercel.com/docs/rewrites), so the two Trooth files are served
// as static files instead: this script downloads them from the Trooth API into
// public/.well-known/ and writes the lasting headers the API sent
// (Content-Digest, ETag and the rest) into vercel.json. It never writes the
// Signature or Signature-Input header there: a response signature is valid for
// about an hour, and a static header would outlive it by days. The file itself
// carries its own signature in its body, and a Link header points readers at
// the live copy on the Trooth API, which is signed on every request. Run it in
// the build command:
//
//   node scripts/semanto-sync.mjs && next build
//
// Rebuild when Trooth publishes a new version: add a Vercel Deploy Hook URL in
// the Trooth dashboard under Delivery, and Trooth calls it on every publish.
// Node 20 or newer, no dependencies.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Headers that stay true as long as the bytes do. Never Signature or Signature-Input: those expire.
const LASTING_HEADERS = ["Content-Type", "ETag", "Vary", "Content-Digest", "Trooth-Contract", "Trooth-Semanto-Version", "Trooth-Page-Hash", "Content-Signal"];

const troothId = process.env.TROOTH_ID;
const apiBase = (process.env.TROOTH_API_BASE || "https://api.trooth.co").replace(/\/+$/, "");
if (!troothId) {
  console.error("semanto-sync: TROOTH_ID is not set; skipping the well-known files.");
  process.exit(0);
}
const root = `${apiBase}/public/semanto/${encodeURIComponent(troothId)}`;

const FILES = [
  { path: "/.well-known/trooth.semanto", url: root, accept: "application/json" },
  { path: "/.well-known/trooth-keys.json", url: `${root}/keys.json`, accept: "application/json" },
];

const projectRoot = process.cwd();
const headerRules = [];
for (const f of FILES) {
  const res = await fetch(f.url, { headers: { Accept: f.accept } });
  if (!res.ok) {
    console.error(`semanto-sync: ${f.url} answered ${res.status}; keeping the previous copy if any.`);
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const target = resolve(projectRoot, "public" + f.path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, bytes);
  const headers = [];
  for (const name of LASTING_HEADERS) {
    const v = res.headers.get(name);
    if (v) headers.push({ key: name, value: v });
  }
  // The live copy, signed on every request.
  headers.push({ key: "Link", value: `<${f.url}>; rel="alternate"; type="application/json"` });
  headers.push({ key: "Cache-Control", value: "public, max-age=300, must-revalidate" });
  headerRules.push({ source: f.path, headers });
  console.log(`semanto-sync: wrote ${target} (${bytes.length} bytes, ${headers.length} headers)`);
}

const vercelJsonPath = resolve(projectRoot, "vercel.json");
let vercelJson = {};
try {
  vercelJson = JSON.parse(await readFile(vercelJsonPath, "utf8"));
} catch {
  vercelJson = {};
}
const kept = (vercelJson.headers || []).filter((h) => !FILES.some((f) => f.path === h.source));
vercelJson.headers = [...kept, ...headerRules];
await writeFile(vercelJsonPath, JSON.stringify(vercelJson, null, 2) + "\n");
console.log(`semanto-sync: updated ${vercelJsonPath}`);
