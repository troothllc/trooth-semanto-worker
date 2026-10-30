// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
import { test } from "node:test";
import assert from "node:assert/strict";
import { semantoFacts, semantoRead, MAX_CHARS } from "./tools.mjs";

const client = {
  read: async (url) => ({ ok: url.endsWith("/pricing"), reason: url.endsWith("/pricing") ? null : "no_signature", text: "y".repeat(MAX_CHARS + 5), version: "smv_x", keyid: "k1", dns: true }),
  facts: async () => ({ ok: true, text: '{"@context":"https://schema.org"}', version: "smv_x", signed_by: "witness" }),
};

test("semanto_read answers the check and the text, cut at MAX_CHARS", async () => {
  const out = JSON.parse((await semantoRead(client, { url: "https://acme.com/pricing" })).content[0].text);
  assert.equal(out.ok, true);
  assert.equal(out.signed_by, "company");
  assert.equal(out.text.length, MAX_CHARS);
  assert.equal(out.cut, true);
  assert.equal((await semantoRead(client, { url: "http://acme.com/" })).isError, true);
});

test("semanto_facts refuses a bad Trooth ID and reads a good one", async () => {
  assert.equal((await semantoFacts(client, { trooth_id: "../x" })).isError, true);
  const out = JSON.parse((await semantoFacts(client, { trooth_id: "acme-inc" })).content[0].text);
  assert.deepEqual([out.ok, out.signed_by, out.trooth_id], [true, "witness", "acme-inc"]);
});
