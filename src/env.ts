// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Worker's bindings, variables and secrets (Cloudflare Workers
// configuration, wrangler.toml). Secrets are set with wrangler secret put and
// never committed.

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
  /** Secret (16 characters or more): the daily salt for hashing a reader's address in read receipts (src/readers/receipts.ts). Without it, receipts keep no address hash. */
  RECEIPT_IP_SALT_SECRET?: string;
  /** Secret (32 characters or more): seals hosted company private keys at rest (src/db/key-seal.ts). Without it, no hosted key is stored. */
  HOSTED_KEY_SEAL_SECRET?: string;
  /** Service binding to trooth-os-worker-f, whose session check accepts workspace bearer tokens for /os routes. Without it, every /os call is refused. */
  TROOTH_OS?: Fetcher;
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
