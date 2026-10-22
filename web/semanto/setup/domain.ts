// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Website field's live cleaning, the same rule the server applies at the
// claim (docs/spec/setup-api.md, "The website field accepts a pasted
// address"): the scheme, a leading www., any path, query and port are
// removed, and the host is lowercased. Plausible's single domain field and
// Vercel's www prompt are the leaders: the person may paste any address and
// sees, under the field, the one domain Semanto will use. Pure.

export type DomainCheck =
  | { ok: true; domain: string; changed: boolean }
  | { ok: false; empty: boolean; message: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function cleanDomain(input: string): DomainCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, empty: true, message: "Type your website address, like example.com." };
  let host = raw.toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.replace(/^[^@]*@/, "");
  host = host.replace(/:\d*$/, "");
  host = host.replace(/\.$/, "");
  host = host.replace(/^www\./, "");
  if (!host) return { ok: false, empty: false, message: "Type your website address, like example.com." };
  if (/\s/.test(host)) return { ok: false, empty: false, message: "A website address has no spaces. Type it like example.com." };
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, empty: false, message: `Add the ending, like ${host}.com.` };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, empty: false, message: "That address has a character a website address cannot have. Type it like example.com." };
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return { ok: false, empty: false, message: "The ending of that address does not look right. Type it like example.com." };
  return { ok: true, domain: host, changed: host !== raw.toLowerCase() };
}
