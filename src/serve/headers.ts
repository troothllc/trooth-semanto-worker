// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The headers on every Semanto response, and the signature over them. One
// function builds a plain { status, headers, body } so handlers stay pure and
// tests need no runtime.
//
//   Content-Type, Vary: Accept, Cache-Control (RFC 9111, with
//     stale-while-revalidate, RFC 5861)
//   ETag: strong, the quoted digest of the bytes served (RFC 9110 8.8.3).
//     Cloudflare's converter drops ETag because its bytes change; Semanto's
//     bytes are signed and stable, so the ETag is kept and 304 works.
//   x-markdown-tokens, x-original-tokens: Cloudflare's names (Markdown for
//     Agents, 26 Feb 2026) so a reader needs one code path.
//   Trooth-Contract, Trooth-Semanto-Version, Trooth-Page-Hash: the proof
//     headers. Trooth-Page-Hash is ALWAYS the digest of the exact body bytes
//     of this response, so a reader can check it against Content-Digest and
//     the body. When the body is derived from a signed page (the page's
//     JSON-LD, the page with the behind notice, its proof object),
//     Trooth-Signed-Page-Hash carries the manifest hash of that page. No X-
//     prefix (RFC 6648).
//   Link: canonical, alternate and the Trooth relations (RFC 8288).
//   Content-Signal: the company's signed content signals (contentsignals.org).
//   Content-Digest (RFC 9530) then Signature-Input and Signature (RFC 9421)
//     over SEMANTO_RESPONSE_COMPONENTS plus every optional component the
//     response carries (Trooth-Signed-Page-Hash, Trooth-Signed-By,
//     Trooth-Semanto-State, Location, Content-Signal, Link), tag
//     "trooth-semanto". The signature lives as long as a cache may serve the
//     response: max-age plus stale-while-revalidate (3,900 seconds). The
//     freshness of the statement is carried by the signed version's own
//     validity, not by the transport signature.
//     The company's hosted key signs when custody is hosted; otherwise
//     Trooth's witness key signs and Trooth-Signed-By: witness says so.
//   Access-Control-Allow-Origin * and Expose-Headers, so a page script or an
//     agent in a browser can read every Trooth header.

import { contentDigest, signMessage, semantoResponseComponents } from "../core/httpsig";
import { digest } from "../core/hash";
import { SEMANTO_CONTRACT } from "../core/semanto";
import type { PrivateJwk } from "../core/keys";
import { contentSignalHeader, type ContentSignals } from "../settings/delivery";

export type ServedRepresentation = "markdown" | "jsonld" | "json" | "problem_json" | "text" | "tsv";

export const CONTENT_TYPES: Record<ServedRepresentation, string> = {
  markdown: "text/markdown; charset=utf-8",
  jsonld: "application/ld+json",
  json: "application/json",
  problem_json: "application/problem+json",
  text: "text/plain; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
};

export const CACHE_MAX_AGE_SECONDS = 300;
export const CACHE_STALE_WHILE_REVALIDATE_SECONDS = 3600;
export const CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${CACHE_STALE_WHILE_REVALIDATE_SECONDS}`;
export const SIGNATURE_TAG = "trooth-semanto";
/** expires = created + max-age + stale-while-revalidate, so a response served at the end of its cache life still verifies. */
export const SIGNATURE_TTL_SECONDS = CACHE_MAX_AGE_SECONDS + CACHE_STALE_WHILE_REVALIDATE_SECONDS;

export const REL = {
  semanto: "https://trooth.co/rel/semanto",
  trustProfile: "https://trooth.co/rel/trust-profile",
  proof: "https://trooth.co/rel/proof",
  keys: "https://trooth.co/rel/keys",
} as const;

/** Every header a cross-origin reader may need to read. */
export const EXPOSED_HEADERS = [
  "Content-Digest",
  "Content-Signal",
  "ETag",
  "Link",
  "Location",
  "Retry-After",
  "Signature",
  "Signature-Input",
  "Trooth-Contract",
  "Trooth-Page-Hash",
  "Trooth-Semanto-State",
  "Trooth-Semanto-Version",
  "Trooth-Signed-By",
  "Trooth-Signed-Page-Hash",
  "x-markdown-tokens",
  "x-original-tokens",
] as const;

export interface LinkTargets {
  /** The HTML page on the company's domain. */
  canonical?: string | null;
  /** The markdown url of the same page. */
  markdown?: string | null;
  /** The JSON-LD url of the same page or of the facts. */
  jsonld?: string | null;
  /** /.well-known/trooth.semanto on the company's domain, or the hosted copy. */
  semanto?: string | null;
  trust_profile?: string | null;
  proof?: string | null;
  keys?: string | null;
}

export interface ResponseSpec {
  status: number;
  rep: ServedRepresentation;
  body: Uint8Array;
  /** The smv_ id of the version the bytes belong to; "none" when there is no signed version (problems before a first signature). */
  version_id: string | null;
  /**
   * The manifest hash of the signed page this body is derived from. Sent as
   * Trooth-Signed-Page-Hash when it differs from the digest of the body;
   * Trooth-Page-Hash is always the digest of the body.
   */
  page_hash?: string | null;
  /** A signed redirect: Location is set and covered by the signature. */
  location?: string | null;
  markdown_tokens?: number | null;
  original_tokens?: number | null;
  content_signals?: ContentSignals | null;
  links?: LinkTargets;
  signer: { key: PrivateJwk; by: "company" | "witness" };
  /**
   * Trooth-Semanto-State: "behind" when the live page changed after the last
   * signature (the last signed bytes are served); "witnessed-not-signed" for a
   * Semanto Basic record, which Trooth witnessed and the company did not sign.
   */
  state?: "behind" | "witnessed-not-signed" | null;
  retry_after_seconds?: number | null;
  /** Clock, so the signature's created and expires are stable in tests. */
  now: Date;
  /** Any other headers the handler wants, set before signing (not covered by the signature). */
  extra?: Record<string, string>;
}

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export function formatLink(t: LinkTargets): string | null {
  const parts: string[] = [];
  if (t.canonical) parts.push(`<${t.canonical}>; rel="canonical"`);
  if (t.markdown) parts.push(`<${t.markdown}>; rel="alternate"; type="text/markdown"`);
  if (t.jsonld) parts.push(`<${t.jsonld}>; rel="alternate"; type="application/ld+json"`);
  if (t.semanto) parts.push(`<${t.semanto}>; rel="${REL.semanto}"`);
  if (t.trust_profile) parts.push(`<${t.trust_profile}>; rel="${REL.trustProfile}"`);
  if (t.proof) parts.push(`<${t.proof}>; rel="${REL.proof}"`);
  if (t.keys) parts.push(`<${t.keys}>; rel="${REL.keys}"`);
  return parts.length ? parts.join(", ") : null;
}

/** Does an If-None-Match field match this strong ETag (RFC 9110 13.1.2)? */
export function ifNoneMatchMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const v = ifNoneMatch.trim();
  if (v === "*") return true;
  return v
    .split(",")
    .map((s) => s.trim().replace(/^W\//, ""))
    .some((s) => s === etag);
}

/**
 * Build the full response. When `ifNoneMatch` matches, the status becomes 304
 * and the body is dropped; every other header, including the signature, is
 * present and the signature covers status 304.
 */
export async function buildResponse(spec: ResponseSpec, request: { ifNoneMatch?: string | null } = {}): Promise<PlainResponse> {
  const servedDigest = await digest(spec.body);
  const etag = `"${servedDigest}"`;
  const notModified = spec.status === 200 && ifNoneMatchMatches(request.ifNoneMatch, etag);
  const status = notModified ? 304 : spec.status;

  const h: Record<string, string> = {};
  h["Content-Type"] = CONTENT_TYPES[spec.rep];
  h["Vary"] = "Accept";
  h["ETag"] = etag;
  h["Cache-Control"] = spec.status >= 400 ? "no-store" : CACHE_CONTROL;
  if (spec.markdown_tokens !== undefined && spec.markdown_tokens !== null) h["x-markdown-tokens"] = String(spec.markdown_tokens);
  if (spec.original_tokens !== undefined && spec.original_tokens !== null) h["x-original-tokens"] = String(spec.original_tokens);
  h["Trooth-Contract"] = String(SEMANTO_CONTRACT);
  h["Trooth-Semanto-Version"] = spec.version_id ?? "none";
  h["Trooth-Page-Hash"] = servedDigest;
  if (spec.page_hash && spec.page_hash !== servedDigest) h["Trooth-Signed-Page-Hash"] = spec.page_hash;
  if (spec.location) h["Location"] = spec.location;
  const link = spec.links ? formatLink(spec.links) : null;
  if (link) h["Link"] = link;
  if (spec.content_signals) h["Content-Signal"] = contentSignalHeader(spec.content_signals);
  if (spec.state) h["Trooth-Semanto-State"] = spec.state;
  if (spec.retry_after_seconds !== undefined && spec.retry_after_seconds !== null) h["Retry-After"] = String(spec.retry_after_seconds);
  if (spec.signer.by === "witness") h["Trooth-Signed-By"] = "witness";
  h["Access-Control-Allow-Origin"] = "*";
  h["Access-Control-Expose-Headers"] = EXPOSED_HEADERS.join(", ");
  for (const [k, v] of Object.entries(spec.extra ?? {})) h[k] = v;

  h["Content-Digest"] = await contentDigest(spec.body);
  const signed = await signMessage({ kind: "response", status, headers: h }, spec.signer.key, {
    components: semantoResponseComponents(h),
    created: Math.floor(spec.now.getTime() / 1000),
    ttlSeconds: SIGNATURE_TTL_SECONDS,
    tag: SIGNATURE_TAG,
  });
  h["Signature-Input"] = signed["Signature-Input"];
  h["Signature"] = signed.Signature;

  return { status, headers: h, body: notModified ? null : spec.body };
}

/** Turn the plain response into a fetch Response. The only place that touches the runtime type. */
export function toResponse(p: PlainResponse): Response {
  const body = p.body === null ? null : (p.body as unknown as BodyInit);
  return new Response(body, { status: p.status, headers: p.headers });
}
