#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// semanto-verify: the command line in front of verify.mjs. It prints what it
// checked in plain words, one line per check, and exits non-zero on any
// failure, the way `cosign verify` and `gh attestation verify` do. `file` and
// the test vectors need no network; `page`, `response` and `log` fetch.
//
//   semanto-verify file <semanto.json> --pages <dir> [--keys <keys.json>] [--now <iso>] [--revocations <file>]
//   semanto-verify page <url>          [--trooth <base>] [--now <iso>]
//   semanto-verify response <url>      [--keys <keys.json>]
//   semanto-verify log --from <n> --to <m> [--log <url>] [--keys <keys.json>]
//
// Pages for `file` are read from <dir>/<page id>.md (the smp_ id in the
// manifest), the layout verifier/test-vectors/v1/pages uses.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveTxt } from "node:dns/promises";
import {
  verifySemanto,
  verifyPageProof,
  verifyResponse,
  verifyTreeHead,
  verifyConsistency,
  verifyRevocationList,
  parseLink,
  parseDnsKeyRecords,
  keyResolver,
  stateOf,
} from "./verify.mjs";

const TROOTH_API = "https://api.trooth.co";
const TROOTH_KEYS = `${TROOTH_API}/.well-known/trooth-keys.json`;
const DEFAULT_LOG = `${TROOTH_API}/public/semanto/log`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[k] = next;
        i++;
      } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function usage(code = 2) {
  process.stderr.write(
    [
      "semanto-verify: check a Semanto file, a page, a signed response or the public log.",
      "",
      "  semanto-verify file <semanto.json> --pages <dir> [--keys <keys.json>] [--now <iso>] [--revocations <file>]",
      "  semanto-verify page <url> [--trooth <base>] [--now <iso>]",
      "  semanto-verify response <url> [--keys <keys.json>]",
      "  semanto-verify log --from <n> --to <m> [--log <url>] [--keys <keys.json>]",
      "",
      "Exit code 0 means every check passed. 1 means at least one failed. 2 means the command was wrong.",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function printChecks(title, result) {
  process.stdout.write(`${title}\n`);
  for (const c of result.checks ?? []) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}\n`);
  if (!result.checks) process.stdout.write(`  ${result.ok ? "ok  " : "FAIL"} ${result.reason ?? ""}\n`);
  process.stdout.write(`${result.ok ? "Every check passed." : `Failed: ${result.reason}.`}\n\n`);
  return result.ok;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

async function loadKeysFor(domain, args) {
  if (args.keys) return readJson(args.keys);
  const troothBase = args.trooth ?? TROOTH_API;
  const sets = [];
  const notes = [];
  for (const url of [`https://${domain}/.well-known/trooth-keys.json`, `${troothBase}/.well-known/trooth-keys.json`]) {
    try {
      sets.push(await fetchJson(url));
      notes.push(`  ok   fetched the JWK Set at ${url}`);
    } catch (e) {
      notes.push(`  note ${url} could not be read (${e.message})`);
    }
  }
  return { keys: sets, notes };
}

async function dnsCheck(domain, kid) {
  try {
    const txt = (await resolveTxt(`_trooth-keys.${domain}`)).map((parts) => parts.join(""));
    const kids = parseDnsKeyRecords(txt);
    if (kids.includes(kid)) return { ok: true, detail: `_trooth-keys.${domain} TXT names key ${kid}.` };
    if (kids.length) return { ok: false, detail: `_trooth-keys.${domain} TXT names ${kids.join(", ")}, not the signing key ${kid}.` };
    return { ok: false, detail: `_trooth-keys.${domain} has no v=trooth1 record.` };
  } catch (e) {
    return { ok: false, detail: `_trooth-keys.${domain} could not be resolved (${e.code ?? e.message}).` };
  }
}

async function cmdFile(args) {
  const path = args._[1];
  if (!path) usage();
  const doc = readJson(path);
  const file = doc.file ?? doc;
  const dir = dirname(path);
  let keys;
  if (args.keys) keys = readJson(args.keys);
  else if (existsSync(join(dir, "keys.json"))) keys = readJson(join(dir, "keys.json"));
  else if (args.offline) keys = {};
  else {
    const loaded = await loadKeysFor(file.header.identity.domain, args);
    keys = loaded.keys;
    for (const n of loaded.notes) process.stdout.write(`${n}\n`);
  }
  const pages = {};
  let pagesDir = args.pages;
  if (!pagesDir && existsSync(join(dir, "pages"))) pagesDir = join(dir, "pages");
  if (pagesDir) {
    for (const p of file.header.pages_manifest) {
      const f = join(pagesDir, `${p.id}.md`);
      if (existsSync(f)) pages[p.url] = new Uint8Array(readFileSync(f));
    }
    const given = Object.keys(pages).length;
    process.stdout.write(`Pages: ${given} of ${file.header.pages_manifest.length} found in ${pagesDir} (${readdirSync(pagesDir).length} files).\n`);
  }
  let revocations = null;
  if (args.revocations) {
    const r = readJson(args.revocations);
    const v = await verifyRevocationList(r.jws ?? r, keys, { now: args.now });
    process.stdout.write(`Revocation list: ${v.ok ? "signed by Trooth" : `not accepted (${v.reason})`}.\n`);
    if (v.ok) revocations = v.payload;
  }
  const result = await verifySemanto(file, pages, keys, { now: args.now ?? doc.now, revocations });
  const ok = printChecks(`Semanto file ${path} (version ${result.version_id ?? "unknown"})`, result);
  process.exit(ok ? 0 : 1);
}

async function cmdResponse(args, { alsoProof = false } = {}) {
  const url = args._[1];
  if (!url) usage();
  const r = await fetch(url, { headers: { Accept: "text/markdown" } });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  process.stdout.write(`GET ${url} with Accept: text/markdown answered ${r.status} ${headers["content-type"] ?? ""}\n`);
  const domain = new URL(url).hostname;
  const loaded = args.keys ? { keys: readJson(args.keys), notes: [] } : await loadKeysFor(domain, args);
  for (const n of loaded.notes) process.stdout.write(`${n}\n`);
  const keys = loaded.keys;
  const now = args.now ? Math.floor(Date.parse(args.now) / 1000) : undefined;
  const resp = await verifyResponse(r.status, headers, body, keys, { now });
  let ok = printChecks("Signed response", resp);
  if (resp.keyid) {
    const dns = await dnsCheck(domain, resp.keyid);
    process.stdout.write(`DNS binding\n  ${dns.ok ? "ok  " : "note"} ${dns.detail}\n\n`);
  }
  if (alsoProof) {
    const links = parseLink(headers.link);
    const isProofRel = (rel) => (rel ?? "").split(/\s+/).some((x) => x === "proof" || x === "https://trooth.co/rel/proof");
    const proofLink = links.find((l) => isProofRel(l.params.rel));
    if (!proofLink) {
      process.stdout.write('Proof\n  FAIL the response has no Link rel="https://trooth.co/rel/proof".\n\n');
      ok = false;
    } else {
      const proofUrl = new URL(proofLink.url, url).href;
      try {
        const doc = await fetchJson(proofUrl);
        const proof = doc.proof ?? doc;
        // The version header lives beside the proof: <api>/<trooth_id>/versions/<n>.
        let header = doc.header ?? null;
        if (!header && Number.isInteger(proof.version)) {
          const versionUrl = proofUrl.replace(/\/pages\/[^/]+\/proof$/, `/versions/${proof.version}`);
          try {
            const version = await fetchJson(versionUrl);
            header = version.header ?? null;
            process.stdout.write(`  ok   fetched the version header at ${versionUrl}\n`);
          } catch (e) {
            process.stdout.write(`  note ${versionUrl} could not be read (${e.message}); the company signature is not checked.\n`);
          }
        }
        const pr = await verifyPageProof(proof, body, keys, { now: args.now, header });
        ok = printChecks(`Proof at ${proofUrl}`, pr) && ok;
        if (header) process.stdout.write(`State now: ${stateOf({ header, root_hash: proof.root_hash, signature: proof.signature }, args.now ? new Date(args.now) : new Date())}.\n\n`);
      } catch (e) {
        process.stdout.write(`Proof\n  FAIL ${proofUrl} could not be read or parsed (${e.message}).\n\n`);
        ok = false;
      }
    }
  }
  process.exit(ok ? 0 : 1);
}

async function cmdLog(args) {
  const from = Number(args.from);
  const to = Number(args.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) usage();
  const log = args.log ?? DEFAULT_LOG;
  const keys = args.keys ? readJson(args.keys) : await fetchJson(args.trooth ? `${args.trooth}/.well-known/trooth-keys.json` : TROOTH_KEYS);
  const resolve = keyResolver(keys);
  if (!resolve) usage();
  const oldHead = await fetchJson(`${log}/tree-head?size=${from}`);
  const newHead = await fetchJson(`${log}/tree-head?size=${to}`);
  const consistency = await fetchJson(`${log}/consistency?from=${from}&to=${to}`);
  let ok = true;
  for (const [name, head] of [
    [`Tree head at size ${from}`, oldHead],
    [`Tree head at size ${to}`, newHead],
  ]) {
    const v = await verifyTreeHead(head, keys, { now: args.now });
    process.stdout.write(`${name}: ${v.ok ? `signed by Trooth key ${v.kid}, root ${v.root_hash}` : `FAIL ${v.reason}`}\n`);
    ok = ok && v.ok;
  }
  const rootOf = (head) => head.payload?.root_hash ?? head.root_hash;
  const c = await verifyConsistency({ from, to, old_root: rootOf(oldHead), new_root: rootOf(newHead), path: consistency.path ?? consistency });
  process.stdout.write(`Consistency ${from} to ${to}: ${c ? "the older tree is a prefix of the newer one; nothing was removed or rewritten" : "FAIL the proof does not connect the two roots"}\n`);
  process.exit(ok && c ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "file") await cmdFile(args);
  else if (cmd === "page") await cmdResponse(args, { alsoProof: true });
  else if (cmd === "response") await cmdResponse(args);
  else if (cmd === "log") await cmdLog(args);
  else usage();
} catch (e) {
  process.stderr.write(`semanto-verify: ${e.message}\n`);
  process.exit(1);
}
