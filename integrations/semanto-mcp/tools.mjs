// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// The two tools, apart from the MCP plumbing so they test on their own.
// Each answers one text block of JSON: whether the copy checked out, why not,
// the version, the DNS result and the text.

export const MAX_CHARS = 20_000;

export const TOOLS = {
  semanto_read: {
    title: "Read a signed page",
    description: "Read a page from a company's website as its signed Semanto copy, and say whether the signature checked against the company's published key.",
  },
  semanto_facts: {
    title: "Read a company's signed facts",
    description: "Read a company's facts as JSON-LD from the Trooth API by its Trooth ID, and say whether the signature checked.",
  },
};

function shape(r, extra = {}) {
  const text = r.text ?? "";
  return { ok: Boolean(r.ok), reason: r.reason ?? null, version: r.version ?? null, signed_by: r.signed_by ?? (r.keyid ? "company" : null), dns: r.dns ?? null, ...extra, text: text.slice(0, MAX_CHARS), cut: text.length > MAX_CHARS };
}

export async function semantoRead(client, { url }) {
  if (!/^https:\/\//.test(String(url))) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "url_must_be_https" }) }], isError: true };
  const r = await client.read(url);
  return { content: [{ type: "text", text: JSON.stringify(shape(r, { url })) }] };
}

export async function semantoFacts(client, { trooth_id }) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(trooth_id))) return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "invalid_trooth_id" }) }], isError: true };
  const r = await client.facts(trooth_id);
  return { content: [{ type: "text", text: JSON.stringify(shape(r, { trooth_id })) }] };
}
