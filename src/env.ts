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
  /** KV: the Web Bot Auth key directory cache and the nonce fallback. */
  CACHE: KVNamespace;
  /** Queue: compile jobs, build stages and the per-company cron fan-out (src/pipeline.ts QueueMessage). */
  COMPILE_QUEUE?: Queue<QueueMessage>;
  /**
   * Trooth's own witness signing key, as a private JWK JSON string (secret).
   * Without it the Worker still answers: routes that sign or witness answer a
   * 503 witness_key_missing problem and the rest keep working.
   */
  TROOTH_WITNESS_KEY?: string;
  /** Earlier witness public keys (JSON array of public JWKs with exp or revoked_at), still served so old signatures check out. */
  TROOTH_WITNESS_PREVIOUS_KEYS?: string;
  /** PKCS #8 PEM of the Domain Connect signing key (secret); only used once a DNS provider has onboarded the template. */
  DOMAIN_CONNECT_PRIVATE_KEY?: string;
  /** Durable Object RateLimitDO (src/readers/rate-limit.ts): token buckets per client and route group, and read receipts counted per minute. */
  RATE?: DurableObjectNamespace;
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
  /** Durable Object NonceDO (src/readers/nonce-do.ts): atomic nonce claims for Web Bot Auth and the connector routes. Without it, the KV fallback (not atomic) is used. */
  NONCES?: DurableObjectNamespace;
  /** Durable Object LogDO (src/ledger/log-do.ts): the one writer for the public log, so appends are serialized. */
  LOG?: DurableObjectNamespace;
  /** "production" or "development"; production refuses to start a build without the compile queue. */
  ENVIRONMENT: "development" | "production";
}

export interface CompileJob {
  trooth_id: string;
  domain: string;
  reason: "first_build" | "change_detected" | "manual" | "scheduled" | "setup";
  /** Only these urls changed; absent means full discovery. */
  changed_urls?: string[];
  requested_at: string;
}

/** The per-company work the crons fan out, at most 25 companies a message. */
export interface CompaniesMessage {
  kind: "companies";
  job: "changes" | "gap" | "proof";
  trooth_ids: string[];
}

/** One build stage (src/compiler/stream.ts StageMessage). */
export type { StageMessage } from "./compiler/stream";
import type { StageMessage } from "./compiler/stream";

export type QueueMessage = CompileJob | StageMessage | CompaniesMessage;
