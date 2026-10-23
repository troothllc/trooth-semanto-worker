// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Reads for the read receipts walk: real requests to the Semanto Worker's
// public routes, some unsigned and some signed by a reading agent with Web Bot
// Auth (draft-ietf-webbotauth-httpsig-protocol), its key directory published at
// the boundary through the QA control server. Signed with the Worker's own
// signer (src/core/httpsig.ts). Run: npx tsx qa/reads.mts <trooth_id>

import { readFileSync } from "node:fs";
import { generateKeyPair } from "../src/core/keys";
import { signMessage, contentDigest } from "../src/core/httpsig";
import { DIRECTORY_PATH } from "../src/readers/webbotauth";

const stack = JSON.parse(readFileSync(new URL("./.run/stack.json", import.meta.url), "utf8"));
const id = process.argv[2];
const worker = stack.semanto as string;
const control = (path: string, body: unknown) => fetch(stack.control + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

async function agent(host: string) {
  const kp = await generateKeyPair();
  const dir = `https://${host}${DIRECTORY_PATH}`;
  const body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: kp.publicJwk.x, kid: kp.publicJwk.kid, alg: "EdDSA", use: "sig" }] });
  const cd = await contentDigest(body);
  const now = Math.floor(Date.now() / 1000);
  const signed = await signMessage({ kind: "response", status: 200, url: dir, headers: { "content-digest": cd } }, kp.privateJwk, { label: "binding", components: ["@authority", "content-digest"], created: now - 10, ttlSeconds: 86400, tag: "http-message-signatures-directory" });
  await control("/directory", { host, body, headers: { "content-type": "application/http-message-signatures-directory+json", "cache-control": "max-age=600", "content-digest": cd, "signature-input": signed["Signature-Input"], signature: signed.Signature } });
  return kp;
}

const file = (await (await fetch(`${worker}/public/semanto/${id}`, { headers: { accept: "application/json" } })).json()) as { header: { pages_manifest: { id: string; url: string }[] } };
const pages = file.header.pages_manifest.map((p) => p.id);
const urls = [`${worker}/public/semanto/${id}`, `${worker}/public/semanto/${id}/facts.jsonld`, ...pages.map((p) => `${worker}/public/semanto/${id}/pages/${p}`)];
let n = 0;
for (const u of urls) {
  const r = await fetch(u, { headers: { accept: "text/markdown", "cf-connecting-ip": "203.0.113.50" } });
  n += r.ok ? 1 : 0;
}
const bots = [await agent("reader.qa-agent-one.com"), await agent("crawler.qa-agent-two.com")];
const hosts = ["reader.qa-agent-one.com", "crawler.qa-agent-two.com"];
let signedOk = 0;
for (let i = 0; i < bots.length; i++) {
  for (const u of urls.slice(0, 4)) {
    const headers: Record<string, string> = { "signature-agent": `"https://${hosts[i]}"`, accept: "text/markdown" };
    const s = await signMessage({ kind: "request", method: "GET", url: u, headers }, bots[i]!.privateJwk, { components: ["@authority", "signature-agent"], created: Math.floor(Date.now() / 1000) - 2, ttlSeconds: 60, nonce: `qa-${i}-${Math.random().toString(36).slice(2)}`, tag: "web-bot-auth" });
    const r = await fetch(u, { headers: { ...headers, ...s, "cf-connecting-ip": `203.0.113.${60 + i}` } });
    if (r.ok) signedOk += 1;
  }
}
console.log(JSON.stringify({ unsigned: n, signed: signedOk }));
