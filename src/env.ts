// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC

export interface Env {
  /** D1: semanto metadata (companies, versions, pages, facts, settings, receipts, log checkpoints). */
  DB: D1Database;
  /** R2: page bodies, Semanto parts, ledger leaves and tiles, feeds. */
  STORE: R2Bucket;
  /** KV: serving cache keys, host detection results, rate limits. */
  CACHE: KVNamespace;
  /** Queue: compile jobs. */
  COMPILE_QUEUE?: Queue<CompileJob>;
  /** Trooth's own witness signing key, as a private JWK JSON string (secret). */
  TROOTH_WITNESS_KEY: string;
  /** Base URLs. */
  PUBLIC_API_BASE: string; // https://api.trooth.co/public/semanto
  NETWORK_BASE: string; // https://trooth.co/network/company
  LEDGER_URL: string; // https://api.trooth.co/public/semanto/log
  /** Provider keys for the gap report (optional; a provider without a key is skipped and said so). */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  /** RFC 3161 timestamp authority URL, same one worker-f anchors with. */
  TSA_URL?: string;
  /** Resend, for plain-language alerts. */
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
  ENVIRONMENT: "development" | "production";
}

export interface CompileJob {
  trooth_id: string;
  domain: string;
  reason: "first_build" | "change_detected" | "manual" | "scheduled";
  /** Only these urls changed; absent means full discovery. */
  changed_urls?: string[];
  requested_at: string;
}
