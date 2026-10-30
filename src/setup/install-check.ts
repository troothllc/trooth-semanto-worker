// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The automatic install check (setup step 8, docs/audit/workflow-research.md
// section 5, Screen F): after the owner puts Semanto on the site, Trooth
// fetches the company's own domain and answers three checks in plain words.
// Pattern: Plausible's background installation check ("can we reach the
// site" apart from "is it working", each failure names its fix) and
// Postmark's automatic turn-green.
//
//   markdown    GET https://<domain>/ with Accept: text/markdown answers 200
//               text/markdown carrying the Semanto proof headers
//   signature   that answer carries an RFC 9421 signature (tag
//               trooth-semanto) that checks out (src/core/httpsig.ts) with an
//               RFC 9530 Content-Digest over the body, and the body is the
//               signed page: its digest is the home page's hash in the
//               current version (or Trooth-Signed-Page-Hash names it when a
//               notice is in front)
//   well_known  /.well-known/trooth.semanto and /.well-known/trooth-keys.json
//               answer the same bytes as the Network copy
//
// On a host where Semanto is two tags in the page's head (Shopify, Webflow, Squarespace, Wix, any other host), the
// site cannot answer markdown or serve /.well-known files, so the same three checks would never pass. There the check
// reads the home page instead, as Google Search Console's HTML tag method does: the Semanto link is in the head, it
// points at this company's signed copy on the Trooth Network, and the well-known files are not needed.
//
// Network calls go through the port, which the Worker builds over the shared
// SSRF guard (src/core/ssrf.ts).

import { bytesEqual } from "../core/encoding";
import { digest } from "../core/hash";
import { SEMANTO_RESPONSE_COMPONENTS, verifyContentDigest, verifyMessage } from "../core/httpsig";
import type { PublicJwk } from "../core/keys";
import { DOUBLE_MARKDOWN_MESSAGE } from "../serve/detect";

export type CheckState = "pass" | "fail" | "pending";

export interface InstallFetchResult {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface InstallCheckPorts {
  fetch(url: string, headers: Record<string, string>): Promise<InstallFetchResult | null>;
}

export interface InstallCheckInput {
  domain: string;
  /** The hash of the signed home page (https://<domain>/) in the current version, or null when the version has none. */
  homePageHash: string | null;
  /** Every page hash in the current version, so a site whose root is another signed page still matches. */
  pageHashes: string[];
  /** The current version's id (an smv_ id), so a copy of an earlier signed version is told apart from a changed page. */
  currentVersionId?: string;
  /** The Network copy of the two well-known documents. */
  networkCopy: { semanto: Uint8Array; keys: Uint8Array };
  /** Resolves a response signature's keyid: the company's keys and Trooth's witness keys. */
  resolveKey(kid: string): Promise<PublicJwk | null> | PublicJwk | null;
  now: Date;
  /** Set on a host where Semanto is the head code: the company's Trooth ID, which the link must name. */
  headCode?: { troothId: string };
}

export interface InstallCheckResult {
  url: string;
  reached: boolean;
  checks: { markdown: CheckState; signature: CheckState; well_known: CheckState };
  messages: { markdown: string; signature: string; well_known: string };
  /** One plain sentence: the success line, or the first failure and its fix. */
  message: string;
  checked_at: string;
}

export const INSTALL_OK = "Your site answers in markdown and the signature checks out.";
export const INSTALL_MESSAGES = {
  unreachable: (d: string) => `Trooth could not reach ${d}. Is the site online?`,
  html: "Your site sent a web page, not markdown. The app or code is not live yet. On WordPress, clear the cache; then check again.",
  cloudflare: `Cloudflare's converter answered instead of Semanto. In the Worker settings, make Semanto run first. ${DOUBLE_MARKDOWN_MESSAGE}`,
  markdownOk: "Your site answers markdown when asked (Accept: text/markdown).",
  noSignature: "Your site's markdown carries no Semanto signature. The app or code is not serving Semanto's answer; check the install steps for your host.",
  badSignature: "The signature on what your site sends does not check out. Make sure the app or code passes Semanto's answer through unchanged, then check again.",
  mismatch: "Your site sent a copy that does not match what you signed. A page changed after signing. Sign the new version, or keep serving the signed one.",
  earlierVersion: "Your site is still sending the version you signed before this one. Its cache refreshes within two minutes; check again then.",
  signatureOk: "The signature on what your site sends matches what you signed.",
  wellKnownMissing: "Your site does not serve /.well-known/trooth.semanto and /.well-known/trooth-keys.json yet. The app or code serves both; check that it is live.",
  wellKnownDiffers: "Your site's /.well-known files differ from the copy on the Trooth Network. Make sure the app or code passes them through unchanged.",
  wellKnownOk: "Your site serves the two /.well-known files exactly as Trooth holds them.",
  headMissing: "Your home page does not carry the Semanto link yet. Paste the head code, publish the site, then check again.",
  headOk: "Your home page carries the Semanto link in its head.",
  headElsewhere: "The Semanto link on your home page points at another company's copy. Paste the head code from your dashboard again, then publish.",
  headTarget: "The link points at your signed copy on the Trooth Network.",
  headNoWellKnown: "Not needed on this host: agents reach your signed copy through the link.",
} as const;
export const INSTALL_OK_HEAD = "Your home page links agents to your signed copy.";

/** The href of the Semanto link in a page's HTML, or null. */
export function semantoLinkHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (rel !== "https://trooth.co/rel/semanto") continue;
    return /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? null;
  }
  return null;
}

async function runHeadCodeCheck(input: InstallCheckInput, ports: InstallCheckPorts, troothId: string): Promise<InstallCheckResult> {
  const url = `https://${input.domain}/`;
  const checked_at = input.now.toISOString();
  const page = await ports.fetch(url, { accept: "text/html" });
  if (!page) {
    const m = INSTALL_MESSAGES.unreachable(input.domain);
    return { url, reached: false, checks: { markdown: "fail", signature: "fail", well_known: "fail" }, messages: { markdown: m, signature: m, well_known: m }, message: m, checked_at };
  }
  const href = page.status === 200 ? semantoLinkHref(new TextDecoder().decode(page.body)) : null;
  const ours = href !== null && href.replace(/\/+$/, "") === `https://api.trooth.co/public/semanto/${troothId}`;
  const markdown: CheckState = href ? "pass" : "fail";
  const signature: CheckState = ours ? "pass" : "fail";
  const markdownMsg = href ? INSTALL_MESSAGES.headOk : INSTALL_MESSAGES.headMissing;
  const signatureMsg = ours ? INSTALL_MESSAGES.headTarget : href ? INSTALL_MESSAGES.headElsewhere : INSTALL_MESSAGES.headMissing;
  const message = ours ? INSTALL_OK_HEAD : href ? signatureMsg : markdownMsg;
  return { url, reached: true, checks: { markdown, signature, well_known: "pass" }, messages: { markdown: markdownMsg, signature: signatureMsg, well_known: INSTALL_MESSAGES.headNoWellKnown }, message, checked_at };
}

export async function runInstallCheck(input: InstallCheckInput, ports: InstallCheckPorts): Promise<InstallCheckResult> {
  if (input.headCode) return runHeadCodeCheck(input, ports, input.headCode.troothId);
  const origin = `https://${input.domain}`;
  const url = `${origin}/`;
  const checked_at = input.now.toISOString();
  const [md, wkSemanto, wkKeys] = await Promise.all([
    ports.fetch(url, { accept: "text/markdown" }),
    ports.fetch(`${origin}/.well-known/trooth.semanto`, { accept: "application/json" }),
    ports.fetch(`${origin}/.well-known/trooth-keys.json`, { accept: "application/json" }),
  ]);
  if (!md && !wkSemanto && !wkKeys) {
    const m = INSTALL_MESSAGES.unreachable(input.domain);
    return { url, reached: false, checks: { markdown: "fail", signature: "fail", well_known: "fail" }, messages: { markdown: m, signature: m, well_known: m }, message: m, checked_at };
  }

  // 1. markdown
  let markdown: CheckState = "fail";
  let markdownMsg: string = INSTALL_MESSAGES.unreachable(input.domain);
  const type = (md?.headers["content-type"] ?? "").toLowerCase();
  const hasProof = Boolean(md?.headers["trooth-page-hash"] && md?.headers["signature-input"]);
  if (md && md.status === 200 && type.startsWith("text/markdown") && hasProof) {
    markdown = "pass";
    markdownMsg = INSTALL_MESSAGES.markdownOk;
  } else if (md && md.status === 200 && type.startsWith("text/markdown") && md.headers["x-markdown-tokens"]) {
    markdownMsg = INSTALL_MESSAGES.cloudflare;
  } else if (md && md.status === 200 && type.startsWith("text/markdown")) {
    markdownMsg = INSTALL_MESSAGES.noSignature;
  } else if (md) {
    markdownMsg = INSTALL_MESSAGES.html;
  }

  // 2. signature, over exactly what the site sent
  let signature: CheckState = "fail";
  let signatureMsg: string = markdown === "pass" ? INSTALL_MESSAGES.noSignature : markdownMsg;
  if (md && markdown === "pass") {
    const nowSec = Math.floor(input.now.getTime() / 1000);
    const v = await verifyMessage({ kind: "response", status: md.status, headers: md.headers }, { resolveKey: (kid) => input.resolveKey(kid), required: [...SEMANTO_RESPONSE_COMPONENTS], tag: "trooth-semanto", now: nowSec });
    const digestOk = await verifyContentDigest(md.headers["content-digest"] ?? null, md.body);
    const bodyHash = await digest(md.body);
    const headerHash = md.headers["trooth-page-hash"] ?? "";
    const signedHash = md.headers["trooth-signed-page-hash"] ?? headerHash;
    const known = new Set([...(input.homePageHash ? [input.homePageHash] : []), ...input.pageHashes]);
    if (!v.ok || !digestOk || bodyHash !== headerHash) signatureMsg = INSTALL_MESSAGES.badSignature;
    else if (!known.has(signedHash)) {
      const served = md.headers["trooth-semanto-version"];
      signatureMsg = input.currentVersionId && served && served !== input.currentVersionId ? INSTALL_MESSAGES.earlierVersion : INSTALL_MESSAGES.mismatch;
    }
    else {
      signature = "pass";
      signatureMsg = INSTALL_MESSAGES.signatureOk;
    }
  }

  // 3. the well-known files, byte for byte
  let well_known: CheckState = "fail";
  let wellKnownMsg: string = INSTALL_MESSAGES.wellKnownMissing;
  const served = Boolean(wkSemanto && wkSemanto.status === 200 && wkKeys && wkKeys.status === 200);
  if (served) {
    if (bytesEqual(wkSemanto!.body, input.networkCopy.semanto) && bytesEqual(wkKeys!.body, input.networkCopy.keys)) {
      well_known = "pass";
      wellKnownMsg = INSTALL_MESSAGES.wellKnownOk;
    } else wellKnownMsg = INSTALL_MESSAGES.wellKnownDiffers;
  }

  const allPass = markdown === "pass" && signature === "pass" && well_known === "pass";
  const message = allPass ? INSTALL_OK : markdown !== "pass" ? markdownMsg : signature !== "pass" ? signatureMsg : wellKnownMsg;
  return { url, reached: true, checks: { markdown, signature, well_known }, messages: { markdown: markdownMsg, signature: signatureMsg, well_known: wellKnownMsg }, message, checked_at };
}
