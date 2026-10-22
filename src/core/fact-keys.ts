// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// One vocabulary of dotted fact keys for every module. The compiler writes
// facts under these keys, the monitor compares surfaces under them, and the
// gap report looks signed facts up by them, so "the phone number" is one key
// from the site read to the alert to the buyer-question finding. Older or
// module-local spellings are listed once here as aliases and resolved through
// canonicalFactKey; nothing else in the codebase keeps its own alias table.
// The keys follow schema.org property names where one exists, in snake case
// (schema.org vocabulary, version 29, 2026).

/** Exact aliases: the spelling on the left reads as the key on the right. */
export const FACT_KEY_ALIASES: Readonly<Record<string, string>> = {
  "contact.telephone": "contact.phone",
  "identity.url": "contact.website",
  "local.phone": "contact.phone",
  "local.address": "contact.address",
  "local.email": "contact.email",
  "local.hours": "hours.opening_hours",
};

/**
 * The one spelling of a fact key. Product keys are written `product.<id>.<field>`;
 * the gap report's per-product form `products.<id>.<field>` reads the same.
 */
export function canonicalFactKey(key: string): string {
  const exact = FACT_KEY_ALIASES[key];
  if (exact) return exact;
  if (key.startsWith("products.")) return `product.${key.slice("products.".length)}`;
  return key;
}

/** True when two keys name the same fact. */
export function sameFactKey(a: string, b: string): boolean {
  return canonicalFactKey(a) === canonicalFactKey(b);
}
