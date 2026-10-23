// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Retry with exponential backoff and full jitter for calls to Shopify and to
// Trooth: a 429 or any 5xx answer, or a network failure, is tried again after
// 1, 2, 4 seconds (capped at 30, and never sooner than a Retry-After header
// asks), up to four attempts; any other answer is returned at once. The
// attempt function is called afresh each time, so a signed request is signed
// again with a new nonce and created time. This is AWS's published backoff
// with full jitter ("Exponential Backoff And Jitter", AWS Architecture Blog).
// When the attempts run out inside the queue consumer, the message itself is
// retried later (workers/app.ts), so a long outage does not lose a sync.

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class RetryExhausted extends Error {
  constructor(
    message: string,
    readonly lastStatus: number | null,
  ) {
    super(message);
  }
}

export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** Seconds from a Retry-After header (delta seconds or an HTTP date), or null. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry(attempt: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastStatus: number | null = null;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    let res: Response | null = null;
    try {
      res = await attempt();
    } catch (e) {
      lastError = e;
    }
    if (res && !isRetryableStatus(res.status)) return res;
    if (res) lastStatus = res.status;
    if (i === attempts - 1) {
      if (res) return res;
      break;
    }
    const backoff = Math.min(max, base * 2 ** i);
    const jittered = Math.floor(random() * backoff);
    const asked = res ? retryAfterMs(res.headers.get("retry-after")) : null;
    await sleep(Math.min(max, Math.max(jittered, asked ?? 0)));
  }
  throw new RetryExhausted(`The request failed after ${attempts} attempts${lastError instanceof Error ? ` (${lastError.message})` : ""}.`, lastStatus);
}
