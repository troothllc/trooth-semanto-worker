// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The setup wizard's data client: one function per route of
// docs/spec/setup-api.md, over fetch, with the bearer token passed in, a
// deadline on every request, and errors turned into plain words with the
// request id a person can quote (the pattern semanto-record-panel.tsx uses,
// after GitHub Primer and Geist: say what happened, what to do, and the id).
// Errors from the API are RFC 9457 problems; the wizard shows their detail
// and next_action, never a raw status.

import type { Competitor, HostKind, InstallCheckAnswer, PasskeyAdded, PasskeyOptionsAnswer, ReviewDocument, ScreenId, SetupState, SignAnswer, SignOptionsAnswer } from "./types";
import type { PasskeyAssertion, PasskeyCredential } from "./browser";

export const REQUEST_TIMEOUT_MS = 15_000;

/** The RFC 9457 problem fields the wizard reads (src/serve/errors.ts Problem). */
export interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  retryable?: boolean;
  next_action?: string;
  terminal?: boolean;
  retry_after?: number;
}

/** An error the wizard can show as it is: what happened, what to do, and the request id. */
export class SetupApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly fix: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(o: { status: number; code: string; detail: string; fix: string | null; requestId: string | null; retryable: boolean; body?: unknown }) {
    super(o.detail);
    this.name = "SetupApiError";
    this.status = o.status;
    this.code = o.code;
    this.detail = o.detail;
    this.fix = o.fix;
    this.requestId = o.requestId;
    this.retryable = o.retryable;
    this.body = o.body;
  }
}

/** Plain words for any error, with the request id when there is one. */
export function errorWords(e: unknown): { detail: string; fix: string | null; requestId: string | null } {
  if (e instanceof SetupApiError) return { detail: e.detail, fix: e.fix, requestId: e.requestId };
  return { detail: "Something went wrong on this page.", fix: "Reload the page. Your progress is kept on Trooth's side.", requestId: null };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: unknown }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface SetupClientOptions {
  /** https://api.trooth.co in production. */
  base: string;
  /** The workspace token. A function, so a refreshed token is used on the next call. */
  token: string | (() => string | Promise<string>);
  timeoutMs?: number;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
}

export interface SetupClient {
  /** GET /os/semanto/setup with no id; GET /os/semanto/{id}/setup with one. */
  state(troothId: string | null): Promise<SetupState>;
  start(body: { org: string; domain: string }): Promise<SetupState>;
  review(troothId: string): Promise<ReviewDocument>;
  lookAgain(troothId: string): Promise<SetupState>;
  readAgain(troothId: string): Promise<SetupState>;
  choose(troothId: string, path: "basic" | "full"): Promise<SetupState>;
  confirm(troothId: string, body: { version: number; root_hash: string }): Promise<SetupState>;
  host(troothId: string, host: HostKind): Promise<SetupState>;
  installCheck(troothId: string): Promise<InstallCheckAnswer>;
  monitoring(troothId: string, body: { questions?: string[]; competitors?: Competitor[] }): Promise<SetupState>;
  saveForLater(troothId: string, screen?: ScreenId): Promise<SetupState>;
  resume(troothId: string): Promise<SetupState>;
  /** POST /os/semanto/{id}/passkeys/options: the options for navigator.credentials.create. */
  passkeyOptions(troothId: string): Promise<PasskeyOptionsAnswer>;
  /** POST /os/semanto/{id}/passkeys: the new passkey, checked and stored by Trooth. */
  addPasskey(troothId: string, credential: PasskeyCredential): Promise<PasskeyAdded>;
  /** POST /os/semanto/{id}/sign/options: a single-use passkey request bound to this version and root hash. */
  signOptions(troothId: string, body: { version?: number }): Promise<SignOptionsAnswer>;
  /**
   * POST /os/semanto/{id}/sign. Hosted custody: the passkey assertion for the version (the key is released only
   * after Trooth checks it). Customer custody: no signature asks for the signing input; then the signature.
   */
  sign(troothId: string, body: { version?: number; signature?: string; assertion?: PasskeyAssertion }): Promise<SignAnswer>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The id a person quotes to support: the header when the browser may read it, else the one the detail names. */
function requestIdOf(headers: { get(name: string): string | null }, detail: string | undefined): string | null {
  const h = headers.get("Trooth-Request-Id");
  if (h) return h;
  const m = /request id ([0-9a-f]{8,32})/i.exec(detail ?? "");
  return m ? m[1]! : null;
}

export function createSetupClient(opts: SetupClientOptions): SetupClient {
  const base = opts.base.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = typeof opts.token === "function" ? await opts.token() : opts.token;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json, application/problem+json", Authorization: `Bearer ${token}` };
    if (method === "POST") headers["Content-Type"] = "application/json";
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: ac.signal });
      // The deadline covers the body too: headers can arrive and the body stall.
      text = await res.text();
    } catch {
      clearTimeout(timer);
      if (ac.signal.aborted) {
        throw new SetupApiError({ status: 0, code: "timeout", detail: `Trooth did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, fix: "Check your connection, then try again. Nothing was lost.", requestId: null, retryable: true });
      }
      throw new SetupApiError({ status: 0, code: "offline", detail: "Trooth could not be reached.", fix: "Check your connection, then try again. Nothing was lost.", requestId: null, retryable: true });
    }
    clearTimeout(timer);
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const p: ProblemBody = isRecord(parsed) ? (parsed as ProblemBody) : {};
      const detail = p.detail ?? p.title ?? `Trooth answered with an error (${res.status}).`;
      throw new SetupApiError({
        status: res.status,
        code: p.code ?? `http_${res.status}`,
        detail,
        fix: p.next_action ?? null,
        requestId: requestIdOf(res.headers, p.detail),
        retryable: p.retryable ?? res.status >= 500,
        body: parsed,
      });
    }
    if (parsed === undefined) {
      throw new SetupApiError({ status: res.status, code: "bad_answer", detail: "Trooth sent an answer this page could not read.", fix: "Reload the page. If it happens again, quote the request id to Trooth support.", requestId: requestIdOf(res.headers, undefined), retryable: true });
    }
    return parsed as T;
  }

  const os = "/os/semanto";
  const id = (t: string) => `${os}/${encodeURIComponent(t)}`;
  return {
    state: (t) => call("GET", t ? `${id(t)}/setup` : `${os}/setup`),
    start: (b) => call("POST", `${os}/setup/start`, b),
    review: (t) => call("GET", `${id(t)}/setup/review`),
    lookAgain: (t) => call("POST", `${id(t)}/setup/look-again`, {}),
    readAgain: (t) => call("POST", `${id(t)}/setup/read-again`, {}),
    choose: (t, path) => call("POST", `${id(t)}/setup/choose`, { path }),
    confirm: (t, b) => call("POST", `${id(t)}/setup/confirm`, b),
    host: (t, host) => call("POST", `${id(t)}/setup/host`, { host }),
    installCheck: (t) => call("POST", `${id(t)}/setup/install-check`, {}),
    monitoring: (t, b) => call("POST", `${id(t)}/setup/monitoring`, b),
    saveForLater: (t, screen) => call("POST", `${id(t)}/setup/save-for-later`, screen ? { screen } : {}),
    resume: (t) => call("POST", `${id(t)}/setup/resume`, {}),
    passkeyOptions: (t) => call("POST", `${id(t)}/passkeys/options`, {}),
    addPasskey: (t, credential) => call("POST", `${id(t)}/passkeys`, { credential }),
    signOptions: (t, b) => call("POST", `${id(t)}/sign/options`, b),
    sign: (t, b) => call("POST", `${id(t)}/sign`, b),
  };
}

/** The public base for the install values: https://api.trooth.co/public/semanto/{id}. */
export function publicSemantoUrl(apiBase: string, troothId: string): string {
  return `${apiBase.replace(/\/+$/, "")}/public/semanto/${encodeURIComponent(troothId)}`;
}
