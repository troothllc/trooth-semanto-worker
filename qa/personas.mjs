// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The test people of the QA stack (qa/stack.mjs). A token is an opaque string
// only the stand-in for worker-f's session check (qa/stack.mjs standIn) knows;
// trooth-web holds it in its httpOnly trooth_session cookie, exactly as the
// journeys stack of trooth-web does (scripts/journeys/stack.mjs PERSONAS), and
// the Semanto Worker reads it through its TROOTH_OS binding. No token here is
// a production credential.

export const COMPANIES = {
  acme: { os_company_id: "co_acme", name: "Acme Goods", domain: "acmegoods-qa.com", slug: "acme-goods" },
  globex: { os_company_id: "co_globex", name: "Globex", domain: "globex-qa.com", slug: "globex" },
};

const confirmed = (domain) => [{ domain, status: "confirmed", confirmed_at: "2026-09-01T10:00:00.000Z", method: "dns" }];

export const PERSONAS = {
  owner: { token: "qa-token-owner-acme", company: "acme", userId: "u-ada", email: "ada@acmegoods-qa.com", name: "Ada Owner", workspaceRole: "owner" },
  admin: { token: "qa-token-admin-acme", company: "acme", userId: "u-bo", email: "bo@acmegoods-qa.com", name: "Bo Admin", workspaceRole: "admin" },
  member: { token: "qa-token-member-acme", company: "acme", userId: "u-cy", email: "cy@acmegoods-qa.com", name: "Cy Member", workspaceRole: "member" },
  viewer: { token: "qa-token-viewer-acme", company: "acme", userId: "u-vi", email: "vi@acmegoods-qa.com", name: "Vi Viewer", workspaceRole: "viewer" },
  // worker-f today sends no workspaceRole (no team seats yet): the Worker reads the registered owner as owner, anyone else as member.
  norole: { token: "qa-token-norole-acme", company: "acme", userId: "u-dee", email: "dee@acmegoods-qa.com", name: "Dee Teammate", workspaceRole: null },
  // The owner on a sign-in two days old: valid, too old for the writes that add reach (lib/session-freshness.ts).
  ownerStale: { token: "qa-token-owner-acme-stale", company: "acme", userId: "u-ada", email: "ada@acmegoods-qa.com", name: "Ada Owner", workspaceRole: "owner", signedInAgoSeconds: 2 * 86400 },
  // An admin whose address was never confirmed.
  unconfirmed: { token: "qa-token-unconfirmed-acme", company: "acme", userId: "u-una", email: "una@acmegoods-qa.com", name: "Una Unconfirmed", workspaceRole: "admin", emailVerified: false },
  // The owner of another company.
  globex: { token: "qa-token-owner-globex", company: "globex", userId: "u-gus", email: "gus@globex-qa.com", name: "Gus Globex", workspaceRole: "owner" },
};

export function domainsFor(p) {
  return confirmed(COMPANIES[p.company].domain);
}
