// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Domain Connect for the Trooth domain claim: the template, discovery, and
// the signed synchronous apply link, ported from the flows blueprint
// (src/lib/domain-connect.ts) to WebCrypto so it runs in the Worker.
//
// Source: the Domain Connect specification (github.com/Domain-Connect/spec)
// and the public template repository (github.com/Domain-Connect/templates).
//
//   Discovery   TXT _domainconnect.{domain} names the DNS provider's API host.
//               GET https://{host}/v2/{domain}/settings returns urlSyncUX; no
//               urlSyncUX means the provider does not offer the synchronous
//               flow for that domain, and the wizard shows the manual table.
//   Apply       {urlSyncUX}/v2/domainTemplates/providers/{providerId}/services/
//               {serviceId}/apply?domain=&challenge=&tid=&fp=&redirect_uri=&state=&sig=&key=
//   Signing     RS256 (RSASSA-PKCS1-v1_5 with SHA-256) over the query string
//               except sig and key, values URL-encoded before signing. The
//               public key is a TXT record named by `key` under the template's
//               syncPubKeyDomain, so nobody can push a different challenge
//               value through Trooth's template.
//   Onboarding  Each DNS provider must onboard trooth.co.domainclaim.json
//               first. Until a provider confirms, it is not on ONBOARDED and
//               no apply link is offered for it (Cloudflare, domain-connect
//               docs; Vercel, domain-connect docs, 8 June 2026).
//
// One template, two records: _trooth-challenge (the proof value) and _trooth
// (the pointer v=trooth1; id=<trooth_id>; key=<kid>). Prefix conflict
// matching replaces only an older Trooth value and never another TXT record.

import { fromBase64, toBase64 } from "../core/encoding";
import { CHALLENGE_RE } from "../basic/tier";

export const DC_PROVIDER_ID = "trooth.co";
export const DC_SERVICE_ID = "domainclaim";
export const DC_KEY_HOST = "_dcpubkeyv1";

export const TROOTH_DOMAIN_CONNECT_TEMPLATE = {
  providerId: DC_PROVIDER_ID,
  providerName: "Trooth",
  serviceId: DC_SERVICE_ID,
  serviceName: "Trooth domain claim",
  version: 1,
  logoUrl: "https://trooth.co/icon.png",
  description: "Adds two TXT records: one shows Trooth you control this domain, one points AI agents to your Trooth record. It changes no other record.",
  variableDescription: "challenge: the public claim value Trooth issued for this domain; tid: the company's Trooth ID; fp: the id of the company's public signing key",
  syncBlock: false,
  syncPubKeyDomain: "trooth.co",
  syncRedirectDomain: "trooth.co",
  warnPhishing: true,
  hostRequired: false,
  records: [
    { type: "TXT", host: "_trooth-challenge", data: "%challenge%", ttl: 3600, txtConflictMatchingMode: "Prefix", txtConflictMatchingPrefix: "trooth-domain-challenge=" },
    { type: "TXT", host: "_trooth", data: "v=trooth1; id=%tid%; key=%fp%", ttl: 3600, txtConflictMatchingMode: "Prefix", txtConflictMatchingPrefix: "v=trooth1" },
  ],
} as const;

/**
 * DNS providers that have onboarded the template, by their Domain Connect
 * providerId, lowercase. Empty until providers confirm: a provider not listed
 * gets the manual table, never a button that fails on their side.
 */
export const ONBOARDED: ReadonlySet<string> = new Set<string>([]);

export interface DiscoveryDeps {
  resolveTxt: (name: string) => Promise<string[]>;
  fetchJson: (url: string) => Promise<unknown>;
  /** Override for tests; production uses ONBOARDED. */
  onboarded?: ReadonlySet<string>;
}

export interface Discovery {
  apiHost: string;
  urlSyncUX: string;
  providerId: string;
  providerName: string | null;
  /** True only when the provider is onboarded. */
  onboarded: boolean;
}

const HOST_RE = /^[a-z0-9.-]+(?::\d+)?(\/[A-Za-z0-9._~/-]*)?$/i;

export async function discover(domain: string, deps: DiscoveryDeps): Promise<Discovery | null> {
  let txt: string[];
  try {
    txt = await deps.resolveTxt(`_domainconnect.${domain}`);
  } catch {
    return null;
  }
  const apiHost = (txt[0] ?? "").trim().replace(/^"+|"+$/g, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!apiHost || !HOST_RE.test(apiHost)) return null;
  let settings: { urlSyncUX?: unknown; providerName?: unknown; providerId?: unknown };
  try {
    settings = (await deps.fetchJson(`https://${apiHost}/v2/${encodeURIComponent(domain)}/settings`)) as typeof settings;
  } catch {
    return null;
  }
  const ux = typeof settings?.urlSyncUX === "string" ? settings.urlSyncUX : "";
  if (!/^https:\/\//.test(ux)) return null;
  const providerName = typeof settings.providerName === "string" ? settings.providerName : null;
  const providerId = (typeof settings.providerId === "string" ? settings.providerId : (providerName ?? apiHost)).toLowerCase();
  const list = deps.onboarded ?? ONBOARDED;
  return { apiHost, urlSyncUX: ux.replace(/\/$/, ""), providerId, providerName, onboarded: list.has(providerId) };
}

export interface ApplyInput {
  urlSyncUX: string;
  domain: string;
  /** The proof value, trooth-domain-challenge= and 48 hex. */
  challenge: string;
  /** The company's Trooth ID. */
  tid: string;
  /** The id of the company's public signing key. */
  fp: string;
  /** Must be on trooth.co (syncRedirectDomain). */
  redirectUri: string;
  /** Opaque, single use, bound to the workspace and claim. */
  state: string;
  /** PKCS #8 PEM of the RSA key whose public half is published at _dcpubkeyv1.trooth.co. */
  privateKeyPem: string;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return fromBase64(b64);
}

/** The signed apply link. The query is built once and signed exactly as sent. */
export async function applyUrl(i: ApplyInput): Promise<string> {
  if (!CHALLENGE_RE.test(i.challenge)) throw new Error("not a Trooth challenge value");
  if (!/^[a-z0-9-]{1,63}$/.test(i.tid)) throw new Error("not a Trooth ID");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(i.fp)) throw new Error("not a key id");
  const r = new URL(i.redirectUri);
  if (r.protocol !== "https:" || r.hostname !== "trooth.co") throw new Error("redirect must be https://trooth.co");
  const q = new URLSearchParams({ domain: i.domain, challenge: i.challenge, tid: i.tid, fp: i.fp, redirect_uri: i.redirectUri, state: i.state }).toString();
  const der = pemToDer(i.privateKeyPem);
  const key = await crypto.subtle.importKey("pkcs8", der.slice().buffer as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(q)));
  return `${i.urlSyncUX}/v2/domainTemplates/providers/${DC_PROVIDER_ID}/services/${DC_SERVICE_ID}/apply?${q}&sig=${encodeURIComponent(toBase64(sig))}&key=${DC_KEY_HOST}`;
}

/**
 * The provider redirects back to redirect_uri with state, and error=access_denied
 * (error_description starting "user_cancel") when the person declines. A
 * return without error is NOT proof: the domain is proven only when the
 * lookup finds the record.
 */
export function readReturn(params: URLSearchParams): { state: string | null; outcome: "applied" | "cancelled" | "failed" } {
  const err = params.get("error");
  const desc = params.get("error_description") ?? "";
  return { state: params.get("state"), outcome: !err ? "applied" : err === "access_denied" && desc.startsWith("user_cancel") ? "cancelled" : "failed" };
}
