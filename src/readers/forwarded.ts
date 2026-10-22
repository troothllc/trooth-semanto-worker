// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Readers proven through an adapter. An agent signs its request to the
// company's domain (Web Bot Auth covers @authority, the company's host). The
// host adapter forwards that request to the Trooth API, where @authority is
// api.trooth.co, so the agent's signature can only be checked against the
// authority the agent actually addressed. The adapter carries it in a signed
// way (RFC 9421, the same mechanism a proxy uses to vouch for what it
// forwards, RFC 9421 section 4.3):
//
//   Signature, Signature-Input, Signature-Agent   the agent's, unchanged
//   Trooth-Forwarded-Authority                    the customer host the agent addressed
//   Trooth-Forwarded-For                          the client address the platform gave
//                                                 the adapter (its own connecting-IP
//                                                 value, never a header the client sent)
//   Trooth-Forwarded-Path                         the path and query the agent asked for
//                                                 on the company's domain
//   Trooth-Connector-Signature-Input              the adapter's own RFC 9421 signature,
//   Trooth-Connector-Signature                    tag "trooth-connector", over @method,
//                                                 @target-uri, trooth-forwarded-authority,
//                                                 trooth-forwarded-for, signature,
//                                                 signature-input, signature-agent
//
// The connector's signature travels in its own two fields because the
// Signature fields already hold the agent's signature, which the connector
// signature covers whole. The API checks the connector signature against that
// company's connector keys first, and only then checks the agent's Web Bot
// Auth signature with the forwarded authority as @authority, and only then
// uses the forwarded address (hashed, never kept, src/readers/receipts.ts).
// A forwarded header without a valid connector signature is ignored. An agent
// that signs @path or @target-uri signed the path it asked for on the
// company's domain, not the API path the adapter calls; it is proven through
// an adapter only when the adapter forwards that path in Trooth-Forwarded-Path
// and covers it with the connector signature, and then that path is used as
// @path. Without it, such an agent is not proven through an adapter. nginx and
// Apache cannot sign, so a read through them is an "unproven reader" unless
// the agent's request reaches the API directly (adapters/README.md).

import { verifyMessage, type HeaderBag } from "@/core/httpsig";
import type { PublicJwk } from "@/core/keys";
import { verifyWebBotAuth, type WebBotAuthDeps, type WebBotAuthResult } from "./webbotauth";

export const CONNECTOR_TAG = "trooth-connector";
export const FORWARDED_AUTHORITY_HEADER = "trooth-forwarded-authority";
export const FORWARDED_FOR_HEADER = "trooth-forwarded-for";
export const FORWARDED_PATH_HEADER = "trooth-forwarded-path";
export const CONNECTOR_SIGNATURE_INPUT_HEADER = "trooth-connector-signature-input";
export const CONNECTOR_SIGNATURE_HEADER = "trooth-connector-signature";
/** What the connector signature on a forwarded request must cover. */
export const FORWARDING_COMPONENTS = ["@method", "@target-uri", FORWARDED_AUTHORITY_HEADER, FORWARDED_FOR_HEADER, "signature", "signature-input", "signature-agent"] as const;
export const FORWARDING_MAX_AGE_SECONDS = 300;

export interface ForwardingContext {
  /** The company's connector keys (POST /os/semanto/{trooth_id}/connectors). */
  connectorKeys: PublicJwk[];
  /** The company's domain: the forwarded authority must be it or one of its subdomains. */
  domain: string;
}

export type ForwardedCheck =
  | { ok: true; authority: string; address: string | null; connector_kid: string; path: string | null; nonce: string | null; expires_ms: number }
  | { ok: false; reason: "not_forwarded" | "unsigned_forwarding" | "bad_connector_signature" | "authority_not_company" | "malformed_authority"; sentence: string };

function header(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const rec = h as Record<string, string | string[] | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
  const v = k ? rec[k] : undefined;
  return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;
const ADDRESS_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;

/** Check the adapter's connector signature on a forwarded request. Nothing forwarded is trusted before this passes. */
export async function verifyForwarding(req: { method: string; url: string; headers: HeaderBag }, ctx: ForwardingContext, nowSeconds: number): Promise<ForwardedCheck> {
  const authority = header(req.headers, FORWARDED_AUTHORITY_HEADER);
  if (!authority) return { ok: false, reason: "not_forwarded", sentence: "The request was not forwarded by an adapter." };
  const si = header(req.headers, CONNECTOR_SIGNATURE_INPUT_HEADER);
  const sg = header(req.headers, CONNECTOR_SIGNATURE_HEADER);
  if (!si || !sg) return { ok: false, reason: "unsigned_forwarding", sentence: "Trooth-Forwarded-Authority came without the adapter's connector signature, so it is ignored." };
  const v = await verifyMessage(
    { kind: "request", method: req.method, url: req.url, headers: req.headers },
    {
      resolveKey: (kid) => ctx.connectorKeys.find((k) => k.kid === kid) ?? null,
      required: [...FORWARDING_COMPONENTS],
      tag: CONNECTOR_TAG,
      now: nowSeconds,
      maxAgeSeconds: FORWARDING_MAX_AGE_SECONDS,
      inputHeader: CONNECTOR_SIGNATURE_INPUT_HEADER,
      signatureHeader: CONNECTOR_SIGNATURE_HEADER,
    },
  );
  if (!v.ok) return { ok: false, reason: "bad_connector_signature", sentence: `The adapter's connector signature did not verify (${v.reason}), so the forwarded authority is ignored.` };
  const host = authority.trim().toLowerCase();
  if (!HOST_RE.test(host)) return { ok: false, reason: "malformed_authority", sentence: "Trooth-Forwarded-Authority is not a host name." };
  const bare = host.replace(/:\d+$/, "");
  const domain = ctx.domain.toLowerCase();
  if (bare !== domain && !bare.endsWith(`.${domain}`)) return { ok: false, reason: "authority_not_company", sentence: `The forwarded authority ${bare} is not ${domain} or one of its subdomains.` };
  const addr = header(req.headers, FORWARDED_FOR_HEADER)?.trim() ?? null;
  // The forwarded path counts only when the connector signature covers it.
  const rawPath = header(req.headers, FORWARDED_PATH_HEADER)?.trim() ?? null;
  const covered = v.components.map((c) => c.toLowerCase()).includes(FORWARDED_PATH_HEADER);
  const path = covered && rawPath && /^\/[^\s#]*$/.test(rawPath) && rawPath.length <= 4096 ? rawPath : null;
  return { ok: true, authority: host, address: addr && ADDRESS_RE.test(addr) ? addr : null, connector_kid: v.keyid, path, nonce: v.params.nonce ?? null, expires_ms: (v.params.expires ?? v.params.created + FORWARDING_MAX_AGE_SECONDS) * 1000 };
}

export interface ReaderProof {
  agent_key_url: string | null;
  proven: boolean;
  keyid: string | null;
  /** The client address the adapter vouched for, when its connector signature checked out. */
  address?: string | null;
  /** True when the request came through an adapter whose connector signature checked out. */
  via_adapter?: boolean;
}

/**
 * The readers hook: a forwarded request is first checked for the adapter's
 * connector signature; when it passes, the agent's Web Bot Auth signature is
 * checked against the forwarded authority. Otherwise the agent's signature is
 * checked against the request as received. A failure proves nothing and names
 * nobody.
 */
export async function proveReader(req: { method: string; url: string; headers: HeaderBag }, deps: WebBotAuthDeps, ctx: ForwardingContext | null): Promise<ReaderProof> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  let url = req.url;
  let address: string | null = null;
  let viaAdapter = false;
  if (ctx && header(req.headers, FORWARDED_AUTHORITY_HEADER)) {
    const f = await verifyForwarding(req, ctx, now);
    // The forwarding signature's nonce is claimed once, so a captured forwarded request cannot be replayed with its vouched address.
    const fresh = f.ok && f.nonce ? await deps.nonces.claim(`fwd:${f.connector_kid}:${f.nonce}`, f.expires_ms, now * 1000) : false;
    if (f.ok && fresh) {
      const u = new URL(req.url);
      url = `https://${f.authority}${f.path ?? `${u.pathname}${u.search}`}`;
      address = f.address;
      viaAdapter = true;
    }
  }
  if (!header(req.headers, "signature") || !header(req.headers, "signature-input")) return { agent_key_url: null, proven: false, keyid: null, ...(viaAdapter ? { address, via_adapter: true } : {}) };
  const r: WebBotAuthResult = await verifyWebBotAuth({ method: req.method, url, headers: req.headers }, deps);
  const base = r.proven ? { agent_key_url: r.agent_key_url, proven: true, keyid: r.keyid } : { agent_key_url: null, proven: false, keyid: null };
  return viaAdapter ? { ...base, address, via_adapter: true } : base;
}
