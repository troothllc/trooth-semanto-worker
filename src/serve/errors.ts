// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Problem details, RFC 9457 (application/problem+json), with the fields the
// house rules require (code, retryable, next_action, terminal), and a markdown
// form for readers that accept text/markdown. The markdown form follows the
// shape Cloudflare gives its 1xxx error pages to agents (Markdown for Agents,
// error pages, 2026): YAML front matter with error_code, http_status,
// retryable and retry_after, then "What happened" and "What you should do".
// Plain words, short sentences, no verdict about any company.

import { utf8 } from "../core/encoding";
import { negotiate } from "../core/negotiate";

export type ProblemCode =
  | "semanto_not_found"
  | "semanto_not_signed"
  | "semanto_version_not_found"
  | "page_not_found"
  | "page_behind"
  | "semanto_withdrawn"
  | "invalid_trooth_id"
  | "unsupported_contract_version"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "conflict"
  | "signature_invalid"
  | "log_entry_not_found"
  | "upstream_unavailable"
  | "session_unavailable"
  | "payload_too_large"
  | "domain_fixed"
  | "domain_claimed_elsewhere"
  | "domain_not_proven"
  | "domain_not_confirmed"
  | "representation_not_offered"
  | "internal_error"
  | "witness_key_missing"
  | "company_key_unavailable"
  | "passkey_missing"
  | "passkey_challenge_expired"
  | "passkey_origin_mismatch"
  | "passkey_cancelled"
  | "passkey_invalid"
  | "passkey_counter"
  | "seller_list_signature"
  | "settings_invalid"
  | "connect_session_not_found"
  | "connect_session_expired"
  | "connect_session_withdrawn"
  | "not_registered";

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: ProblemCode;
  retryable: boolean;
  /** What the reader should do next, in plain words. */
  next_action: string;
  /** True when no retry will change the answer. */
  terminal: boolean;
  retry_after?: number;
  /** Members a route adds beside the standard ones (RFC 9457 extension members), such as issues for settings_invalid. */
  [extension: string]: unknown;
}

interface Catalog {
  status: number;
  title: string;
  retryable: boolean;
  terminal: boolean;
  what_happened: string;
  what_to_do: string;
}

export const PROBLEMS: Record<ProblemCode, Catalog> = {
  semanto_not_found: {
    status: 404,
    title: "No Semanto file for this company",
    retryable: false,
    terminal: true,
    what_happened: "No company with this Trooth ID has a Semanto file.",
    what_to_do: "Check the Trooth ID. The company's page on the Trooth Network lists it.",
  },
  semanto_not_signed: {
    status: 409,
    title: "The company has not signed its file yet",
    retryable: true,
    terminal: false,
    what_happened: "The company has a Semanto file in progress, but no version has been signed. Only signed versions are served.",
    what_to_do: "Read the company's HTML pages for now. Try again later; the file will be served here once the company signs it.",
  },
  semanto_version_not_found: {
    status: 404,
    title: "No such version",
    retryable: false,
    terminal: true,
    what_happened: "This company has no version with that number.",
    what_to_do: "List the versions at the versions endpoint and pick one that exists.",
  },
  page_not_found: {
    status: 404,
    title: "This page is not in the signed file",
    retryable: false,
    terminal: true,
    what_happened: "The current signed version does not contain a page with this id or url.",
    what_to_do: "Read the page's HTML directly. Check sitemap.md for the pages the company signed.",
  },
  page_behind: {
    status: 200,
    title: "The live page changed after the last signature",
    retryable: true,
    terminal: false,
    what_happened: "The company's live HTML page changed after this version was signed. The bytes below are the last signed version, not the live page.",
    what_to_do: "Use these bytes when you need a signed statement. Read the live HTML when you need the newest words. A new signature will replace this notice.",
  },
  semanto_withdrawn: {
    status: 410,
    title: "The company withdrew this version",
    retryable: false,
    terminal: true,
    what_happened: "The company withdrew this version. Withdrawn versions are not served; the withdrawal is recorded in the public log.",
    what_to_do: "Request the current version without a version number.",
  },
  invalid_trooth_id: {
    status: 400,
    title: "That is not a Trooth ID",
    retryable: false,
    terminal: true,
    what_happened: "A Trooth ID is a lowercase slug: letters, digits and hyphens, up to 63 characters.",
    what_to_do: "Correct the id and try again.",
  },
  unsupported_contract_version: {
    status: 406,
    title: "Unsupported contract version",
    retryable: false,
    terminal: true,
    what_happened: "The request asked for a Semanto contract version this server does not speak. This server speaks contract 1.",
    what_to_do: "Ask for contract 1, or update your reader.",
  },
  rate_limited: {
    status: 429,
    title: "Too many requests",
    retryable: true,
    terminal: false,
    what_happened: "This reader sent more requests than the limit allows in the current window.",
    what_to_do: "Wait for the number of seconds in Retry-After, then try again.",
  },
  unauthorized: {
    status: 401,
    title: "Sign in first",
    retryable: false,
    terminal: true,
    what_happened: "This address is for a company's own workspace. The request carried no workspace session, or one that has ended.",
    what_to_do: "Send the workspace token from trooth.co as Authorization: Bearer, or sign in again.",
  },
  forbidden: {
    status: 403,
    title: "Not allowed for this workspace",
    retryable: false,
    terminal: true,
    what_happened: "The workspace session is valid, but it does not belong to this company, or its role cannot do this.",
    what_to_do: "Use the workspace of the company named in the address, or ask an owner or admin.",
  },
  invalid_request: {
    status: 400,
    title: "The request is not in the right shape",
    retryable: false,
    terminal: true,
    what_happened: "A field is missing or has a value this address does not accept.",
    what_to_do: "Read the detail, correct the request and send it again.",
  },
  conflict: {
    status: 409,
    title: "Not possible in the current state",
    retryable: true,
    terminal: false,
    what_happened: "The company's record is not in the state this step needs.",
    what_to_do: "Read the detail for the step that comes first, do it, then try again.",
  },
  signature_invalid: {
    status: 422,
    title: "The signature does not check out",
    retryable: false,
    terminal: true,
    what_happened: "The signature sent does not verify with the public key on file for this company.",
    what_to_do: "Sign the exact signing input you were given, with the private key whose public half is on file, and send the 64-byte signature again.",
  },
  log_entry_not_found: {
    status: 404,
    title: "No such entry in the public log",
    retryable: false,
    terminal: true,
    what_happened: "The log has no leaf, tree head or proof for the numbers asked for.",
    what_to_do: "Read the latest tree head at /public/semanto/log/tree-head and ask within its size.",
  },
  upstream_unavailable: {
    status: 502,
    title: "A source Trooth reads did not answer",
    retryable: true,
    terminal: false,
    what_happened: "Trooth asked an outside source (a registry or the company's site) and got no usable answer.",
    what_to_do: "Try again in a few minutes.",
  },
  session_unavailable: {
    status: 503,
    title: "Trooth could not check your sign-in",
    retryable: true,
    terminal: false,
    what_happened: "The service that checks workspace sign-ins did not answer. Your sign-in was not refused and nothing was changed.",
    what_to_do: "Try again in a minute. You do not need to sign in again.",
  },
  payload_too_large: {
    status: 413,
    title: "The request body is too large",
    retryable: false,
    terminal: true,
    what_happened: "The body is larger than this route reads. Nothing was read or stored.",
    what_to_do: "Send it in smaller parts.",
  },
  domain_fixed: {
    status: 409,
    title: "The domain cannot change",
    retryable: false,
    terminal: true,
    what_happened: "The domain was fixed when the company was claimed. Later requests cannot change it.",
    what_to_do: "Use the domain on the claim. To set up a different domain, use a different Trooth workspace.",
  },
  domain_claimed_elsewhere: {
    status: 409,
    title: "Another Trooth workspace holds this domain",
    retryable: false,
    terminal: true,
    what_happened: "This domain is already held by another Trooth workspace.",
    what_to_do: "Ask to join that workspace, or ask Trooth to review the claim.",
  },
  domain_not_proven: {
    status: 409,
    title: "Prove the domain first",
    retryable: true,
    terminal: false,
    what_happened: "Nothing is built for publication, signed, witnessed or served until the company proves it controls its domain.",
    what_to_do: "Confirm the domain on trooth.co: https://trooth.co/dashboard/public-page?tab=domain. Semanto reads it from there.",
  },
  domain_not_confirmed: {
    status: 409,
    title: "Confirm your domain on trooth.co",
    retryable: true,
    terminal: false,
    what_happened: "Semanto takes the website only from the domains this workspace has confirmed on trooth.co.",
    what_to_do: "Add and confirm the domain at https://trooth.co/dashboard/public-page?tab=domain, then start again.",
  },
  representation_not_offered: {
    status: 404,
    title: "This format is turned off",
    retryable: false,
    terminal: true,
    what_happened: "The company turned this format off in its delivery settings.",
    what_to_do: "Ask for another format, or read the company's HTML pages.",
  },
  internal_error: {
    status: 500,
    title: "Something failed inside Trooth",
    retryable: true,
    terminal: false,
    what_happened: "A step failed inside Trooth. Nothing outside Trooth caused it.",
    what_to_do: "Try again in a few minutes. If it keeps failing, quote the request id to Trooth support.",
  },
  passkey_missing: {
    status: 409,
    title: "Add a signing passkey first",
    retryable: false,
    terminal: false,
    what_happened: "Trooth keeps your company's signing key and releases it only after you use your signing passkey. You have no signing passkey on file yet. It is separate from the passkey or code you sign in with.",
    what_to_do: "Add a signing passkey first: ask for the options at POST /os/semanto/{trooth_id}/passkeys/options, create the passkey on your device, and send it to POST /os/semanto/{trooth_id}/passkeys. Then sign again.",
  },
  passkey_challenge_expired: {
    status: 409,
    title: "The passkey step took too long",
    retryable: true,
    terminal: false,
    what_happened: "The passkey request has expired or was already used. Each one works once, for five minutes.",
    what_to_do: "Start the passkey step again. Nothing was signed.",
  },
  passkey_origin_mismatch: {
    status: 403,
    title: "The passkey step ran on another site",
    retryable: false,
    terminal: true,
    what_happened: "The passkey answer came from a page that is not trooth.co, so Trooth did not use it.",
    what_to_do: "Open trooth.co directly in your browser and try again. Nothing was signed.",
  },
  passkey_cancelled: {
    status: 400,
    title: "The passkey step did not finish",
    retryable: true,
    terminal: false,
    what_happened: "No passkey answer was sent, so the signing key was not released. Nothing was signed.",
    what_to_do: "Press the button again and finish the step on your device (fingerprint, face or PIN).",
  },
  passkey_invalid: {
    status: 422,
    title: "The passkey answer does not check out",
    retryable: true,
    terminal: false,
    what_happened: "Trooth could not match the passkey answer to your passkey and this request. Nothing was signed.",
    what_to_do: "Start the passkey step again on this device. If it keeps failing, add the passkey again.",
  },
  passkey_counter: {
    status: 422,
    title: "This passkey may have been copied",
    retryable: false,
    terminal: true,
    what_happened: "The passkey's counter did not go up, which can mean someone copied it. Trooth did not release the signing key.",
    what_to_do: "Use another passkey, or remove this one and add a new one. Contact Trooth support if you did not expect this.",
  },
  settings_invalid: {
    status: 422,
    title: "These settings cannot be saved as they are",
    retryable: false,
    terminal: true,
    what_happened: "One or more settings do not work together. Nothing was saved. The issues list says which, in plain words.",
    what_to_do: "Change the settings the issues name and save again.",
  },
  connect_session_not_found: {
    status: 404,
    title: "No such connect request",
    retryable: false,
    terminal: true,
    what_happened: "There is no connect request with this id.",
    what_to_do: "Start again from the app you are connecting.",
  },
  connect_session_expired: {
    status: 410,
    title: "This connect request has expired",
    retryable: false,
    terminal: true,
    what_happened: "Connect requests last 15 minutes. This one was not approved in time, so nothing was connected.",
    what_to_do: "Start again from the app you are connecting.",
  },
  connect_session_withdrawn: {
    status: 409,
    title: "The store withdrew this request",
    retryable: false,
    terminal: true,
    what_happened: "The app was removed or disconnected before the request was approved, so it took the request back. Nothing was connected.",
    what_to_do: "Start again from the app you are connecting.",
  },
  not_registered: {
    status: 404,
    title: "This key was never registered",
    retryable: false,
    terminal: true,
    what_happened: "The request is signed by a connector key Trooth has no record of, so there is nothing to revoke.",
    what_to_do: "Nothing to do: the key never reached Trooth. If you expected it to, connect the app again.",
  },
  seller_list_signature: {
    status: 422,
    title: "The seller list signature does not check out",
    retryable: false,
    terminal: true,
    what_happened: "The seller list is not signed by a key this company held when the list was issued, or the signature does not match the list. Nothing was stored.",
    what_to_do: "Sign the exact list with your current signing key (typ seller-list) and send it again.",
  },
  company_key_unavailable: {
    status: 503,
    title: "This company's signing key is not available right now",
    retryable: true,
    terminal: false,
    what_happened: "Trooth holds this company's signing key and could not read it just now, so nothing was signed in the company's name. Trooth never signs a company's content with its own key instead.",
    what_to_do: "Try again in a few minutes. Trooth has been alerted.",
  },
  witness_key_missing: {
    status: 503,
    title: "This deployment cannot sign yet",
    retryable: true,
    terminal: false,
    what_happened: "Trooth's witness key is not set on this deployment, so nothing can be signed or witnessed here yet. This answer carries no signature for the same reason.",
    what_to_do: "Try again later. The operator sets the witness key as a Worker secret.",
  },
};

export function problem(code: ProblemCode, opts: { detail?: string; instance?: string; retry_after?: number; extensions?: Record<string, unknown> } = {}): Problem {
  const c = PROBLEMS[code];
  return {
    ...(opts.extensions ?? {}),
    type: `https://trooth.co/problems/${code}`,
    title: c.title,
    status: c.status,
    detail: opts.detail ?? c.what_happened,
    ...(opts.instance ? { instance: opts.instance } : {}),
    code,
    retryable: c.retryable,
    next_action: c.what_to_do,
    terminal: c.terminal,
    ...(opts.retry_after !== undefined ? { retry_after: opts.retry_after } : {}),
  };
}

/** The YAML front matter and sections of the markdown form. */
export function problemMarkdown(p: Problem): string {
  const lines = ["---", `error_code: ${p.code}`, `http_status: ${p.status}`, `retryable: ${p.retryable}`];
  if (p.retry_after !== undefined) lines.push(`retry_after: ${p.retry_after}`);
  lines.push("terminal: " + p.terminal, "---", "", `# ${p.title}`, "", "## What happened", "", p.detail, "", "## What you should do", "", p.next_action, "");
  return lines.join("\n");
}

export function problemJson(p: Problem): string {
  return JSON.stringify(p);
}

/** Choose the form by Accept (never User-Agent) and render the bytes. */
export function renderProblem(p: Problem, accept: string | null | undefined): { rep: "markdown" | "problem_json"; body: Uint8Array } {
  const rep = negotiate(accept, ["markdown", "json"], "json");
  if (rep === "markdown") return { rep: "markdown", body: utf8(problemMarkdown(p)) };
  return { rep: "problem_json", body: utf8(problemJson(p)) };
}

// ------------------------------------------------- the "behind" notice on a page

/**
 * When the live page changed after the last signature, the last signed bytes
 * are served with this front matter in front of them. The signed bytes follow
 * unchanged; Trooth-Page-Hash, the ETag and Content-Digest cover what was
 * actually sent, and Trooth-Signed-Page-Hash names the signed bytes. A
 * verifier strips the notice with stripBehindNotice before hashing.
 */
export function behindNotice(signed_at: string, version_id: string): string {
  const c = PROBLEMS.page_behind;
  return [
    "---",
    "trooth_state: behind",
    `trooth_signed_at: ${signed_at}`,
    `trooth_semanto_version: ${version_id}`,
    `what_happened: ${c.what_happened}`,
    `what_you_should_do: ${c.what_to_do}`,
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * Semanto Basic: every markdown body of a record Trooth witnessed and the
 * company did not sign carries this front matter first, in the same shape as
 * the behind notice and stripped the same way.
 */
export function basicNotice(notice: string): string {
  return ["---", "trooth_state: witnessed-not-signed", `notice: ${notice}`, "---", "", ""].join("\n");
}

const BEHIND_RE = /^---\ntrooth_state: (?:behind|witnessed-not-signed)\n(?:[^\n]*\n)*?---\n\n/;

export function stripBehindNotice(body: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(body);
  const m = BEHIND_RE.exec(text);
  if (!m) return body;
  return body.slice(utf8(m[0]).length);
}

/**
 * The session service did not answer (a network error or a 5xx). Thrown, not
 * folded into null, so the routes answer 503 session_unavailable instead of a
 * 401 that tells a signed-in person to sign in again (QA-12).
 */
export class SessionUnavailable extends Error {
  constructor(readonly status: number | null) {
    super(`The TROOTH_OS session service did not answer (${status ?? "network error"}).`);
    this.name = "SessionUnavailable";
  }
}
