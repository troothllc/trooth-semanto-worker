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
  | "payload_too_large";

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
    what_to_do: "Wait for the number of seconds in Retry-After, then try again. Signed agents (Web Bot Auth) get a higher limit.",
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
  payload_too_large: {
    status: 413,
    title: "The request body is too large",
    retryable: false,
    terminal: true,
    what_happened: "The body is larger than this route reads. Nothing was read or stored.",
    what_to_do: "Send it in smaller parts.",
  },
};

export function problem(code: ProblemCode, opts: { detail?: string; instance?: string; retry_after?: number } = {}): Problem {
  const c = PROBLEMS[code];
  return {
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
