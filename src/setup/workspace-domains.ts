// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The WorkspaceDomains port: which domains the signed-in workspace has
// claimed on trooth.co, and which of them are confirmed. One signup, one
// domain proof (founder decision, 22 Oct 2026): Semanto is a second product in
// the same trooth.co account, so it never runs a domain claim or a DNS proof
// of its own for a workspace that comes through trooth.co. The domain list on
// /dashboard/public-page?tab=domain (badges "Confirmed" and "Unconfirmed") is
// the one source, and a domain confirmed there counts as proven for Semanto,
// recorded with the source "trooth_domain_claim" and the confirmation date.
//
// The list is read from worker-f through the TROOTH_OS service binding with
// the caller's own credential: GET https://api.trooth.co/auth/domain-claims
// (worker-f src/app-api.ts, the session's own rows of trooth.co's
// domain_claims table, owner_id = the session email, the same rows the domain
// tab reads). The address names api.trooth.co, not the binding's internal
// host, so a DPoP proof trooth.co's server signed for that exact address
// (RFC 9449, htu) passes worker-f's gate unchanged; the proof arrives on the
// request as the Trooth-Os-Domains-Proof header and is used once.
//
// The pattern is Stripe Connect's: a connected product reads the account's
// confirmed state from the platform instead of asking the person again.

/** One domain from the workspace's list on trooth.co. */
export interface WorkspaceDomain {
  /** Lowercase ASCII host, as trooth.co stores it (no scheme, no www.). */
  domain: string;
  /** The badge on trooth.co: "Confirmed" or "Unconfirmed". */
  status: "confirmed" | "unconfirmed";
  /** When trooth.co confirmed it, ISO 8601, or null while unconfirmed. */
  confirmed_at: string | null;
  /** How trooth.co confirmed it ("dns", "email" or "idp"), when it says. */
  method: string | null;
}

/** The answer: the list, or why it could not be read. An unread list is never "no domains". */
export type WorkspaceDomainsAnswer = { ok: true; domains: WorkspaceDomain[] } | { ok: false; reason: "unauthorized" | "unavailable" };

export interface WorkspaceDomainsPort {
  list(): Promise<WorkspaceDomainsAnswer>;
}

/** Where worker-f answers the session's own domain claims. Reached through the TROOTH_OS binding; the host is kept for DPoP. */
export const TROOTH_OS_DOMAINS_URL = "https://api.trooth.co/auth/domain-claims";

/** The page on trooth.co where a person adds and confirms a domain. Semanto links here; it has no proof screen of its own. */
export const CONFIRM_DOMAIN_URL = "https://trooth.co/dashboard/public-page?tab=domain";

/** The source recorded when a domain confirmed on trooth.co proves it for Semanto. */
export const TROOTH_DOMAIN_CLAIM = "trooth_domain_claim" as const;

/** The header trooth.co's server sends with the DPoP proof for TROOTH_OS_DOMAINS_URL. */
export const DOMAINS_PROOF_HEADER = "trooth-os-domains-proof";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** worker-f's answer, read strictly: a row that is not a plain domain is dropped, never guessed at. Null when the shape is wrong. */
export function parseWorkspaceDomains(body: unknown): WorkspaceDomain[] | null {
  if (!isRecord(body) || !Array.isArray(body.domains)) return null;
  const out: WorkspaceDomain[] = [];
  for (const row of body.domains) {
    if (!isRecord(row) || typeof row.domain !== "string") continue;
    const domain = row.domain.trim().toLowerCase();
    if (!HOST_RE.test(domain) || domain.length > 253) continue;
    const at = typeof row.confirmed_at === "string" && !Number.isNaN(Date.parse(row.confirmed_at)) ? new Date(row.confirmed_at).toISOString() : null;
    // Confirmed means a confirmation date: a row that says confirmed without one is read as unconfirmed.
    const status = row.status === "confirmed" && at ? "confirmed" : "unconfirmed";
    out.push({ domain, status, confirmed_at: status === "confirmed" ? at : null, method: typeof row.method === "string" && row.method ? row.method : null });
  }
  return out;
}

/** The confirmed row for a domain, or null. */
export function confirmedDomain(list: WorkspaceDomain[], domain: string): WorkspaceDomain | null {
  const d = domain.toLowerCase();
  return list.find((x) => x.domain === d && x.status === "confirmed" && x.confirmed_at !== null) ?? null;
}

/** The workspace's confirmed domains, the earliest confirmed first (the one a workspace has held longest). */
export function confirmedDomains(list: WorkspaceDomain[]): WorkspaceDomain[] {
  return list.filter((x) => x.status === "confirmed" && x.confirmed_at !== null).sort((a, b) => Date.parse(a.confirmed_at!) - Date.parse(b.confirmed_at!) || a.domain.localeCompare(b.domain));
}

/** The slice of a Cloudflare service binding this needs. */
interface ServiceFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * The port over the TROOTH_OS binding, bound to one caller: their bearer
 * token and, when trooth.co's server sent one, the DPoP proof for the domains
 * address. Read once per request (the answer is memoized), so a proof is never
 * sent twice.
 */
export function troothOsWorkspaceDomains(service: ServiceFetcher | undefined, credential: { token: string; proof: string | null }): WorkspaceDomainsPort {
  let answer: Promise<WorkspaceDomainsAnswer> | null = null;
  async function read(): Promise<WorkspaceDomainsAnswer> {
    if (!service) return { ok: false, reason: "unavailable" };
    const headers: Record<string, string> = { accept: "application/json" };
    if (credential.proof) {
      headers.authorization = `DPoP ${credential.token}`;
      headers.dpop = credential.proof;
    } else headers.authorization = `Bearer ${credential.token}`;
    let res: Response;
    try {
      res = await service.fetch(TROOTH_OS_DOMAINS_URL, { method: "GET", headers });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
    if (res.status !== 200) return { ok: false, reason: "unavailable" };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    const domains = parseWorkspaceDomains(body);
    return domains ? { ok: true, domains } : { ok: false, reason: "unavailable" };
  }
  return {
    list() {
      answer ??= read();
      return answer;
    },
  };
}

/** In memory, for tests: a fixed list, or a failed read. */
export function memoryWorkspaceDomains(domains: WorkspaceDomain[] | "unavailable" | "unauthorized"): WorkspaceDomainsPort {
  return { list: async () => (typeof domains === "string" ? { ok: false, reason: domains } : { ok: true, domains: domains.map((d) => ({ ...d })) }) };
}
