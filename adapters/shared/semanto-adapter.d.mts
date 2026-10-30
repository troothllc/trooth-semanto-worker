// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Types for semanto-adapter.mjs, so the TypeScript adapters and the tests
// compile under strict mode without a build step.

export const DEFAULT_API_BASE: string;
export const MODES: readonly string[];
export const TROOTH_HEADERS: readonly string[];
export const FORWARDED_REQUEST_HEADERS: readonly string[];
export const REL_SEMANTO: string;
export const OFFERED: readonly string[];
export const API_PATHS: {
  manifest: string;
  keys: string;
  facts: string;
  llms: string;
  llmsFull: string;
  sitemap: string;
  page: string;
  byPath: string;
};
export const WELL_KNOWN_FILES: Record<string, { api: string; group: "well_known" | "llms" }>;

export type Mode = "semanto_only" | "semanto_then_cloudflare_for_unsigned" | "proof_only";
export type Representation = "html" | "markdown" | "jsonld";

export interface AdapterConfig {
  troothId: string;
  apiBase?: string;
  mode?: Mode | string;
  method?: string;
  /** The connector private JWK, or its JSON (TROOTH_CONNECTOR_KEY): signs forwarded reader requests. */
  connectorKey?: string | { kty: string; crv: string; x: string; d: string; kid: string };
  /** The client address, when the host knows it better than the request headers do. */
  clientAddress?: string;
  /** Unix seconds, for the forwarding signature's created (tests pin it). */
  now?: () => number;
}

export interface ManifestPage {
  id: string;
  url: string;
  hash?: string;
  title?: string;
}

export type Manifest = unknown;

export type Decision =
  | { serve: true; url: string; kind: "well_known" | "llms" | "facts" | "page" | "page_lookup" | "page_jsonld"; representation: Representation | null; page?: ManifestPage }
  | { serve: false; reason: "method" | "html" | "mode" | "not_listed" };

export function parseAccept(accept: string | null | undefined): { type: string; subtype: string; q: number; order: number; specificity: number }[];
export function negotiate(accept: string | null | undefined, offered?: Representation[], fallback?: Representation): Representation;
export function representationFromPath(pathname: string): { rep: Representation | null; basePath: string };
export function normalizePath(pathname: string): string;
export function pagesOf(manifest: Manifest): ManifestPage[];
export function manifestVersion(manifest: Manifest): string | null;
export function findPage(manifest: Manifest, pathname: string): ManifestPage | null;
export function apiRoot(config: AdapterConfig): string;
export function normalizeMode(mode: unknown): Mode;
export function decide(path: string, accept: string | null | undefined, manifest: Manifest, config: AdapterConfig): Decision;
export function copyHeaders(responseOrHeaders: Response | Headers | Record<string, string>): Headers;
export function forwardRequestHeaders(requestHeaders: Headers): Headers;
export function proofHeaders(manifest: Manifest, pathname: string, config: AdapterConfig): Record<string, string>;
export function withProofHeaders(response: Response, manifest: Manifest, pathname: string, config: AdapterConfig): Response;

export interface ManifestStore {
  get(key: string): Promise<{ etag: string | null; manifest: Manifest; fetchedAt: number } | null>;
  put(key: string, value: { etag: string | null; manifest: Manifest; fetchedAt: number }): Promise<void>;
}
export interface ManifestCache {
  get(): Promise<Manifest | null>;
  peek(): Promise<Manifest | null>;
  settle(): Promise<void>;
}
export function createManifestCache(options: {
  config: AdapterConfig;
  fetchImpl?: typeof fetch;
  store?: ManifestStore;
  ttlSeconds?: number;
  now?: () => number;
  timeoutMs?: number;
  waitUntil?: ((p: Promise<unknown>) => void) | null;
}): ManifestCache;
export function withDeadline<T, F>(promise: Promise<T> | T, ms: number, fallback: F): Promise<T | F>;

export const DELIVERY_HEADER: string;
export const CONTENT_TIMEOUT_MS: number;
export const MANIFEST_TIMEOUT_MS: number;
export const BREAKER_FAILURES: number;
export const BREAKER_WINDOW_MS: number;
export const STALE_MAX_AGE_MS: number;
export const STALE_MAX_ENTRIES: number;
export const STALE_MAX_BYTES: number;
export const SIGNATURE_HEADERS: readonly string[];
export const SIGNATURE_DEFAULT_LIFETIME_S: number;
export interface StaleEntry {
  body: ArrayBuffer;
  headers: [string, string][];
  storedAt: number;
}
export interface StaleStore {
  get(key: string): StaleEntry | null;
  put(key: string, entry: StaleEntry): void;
  size(): number;
}
export interface Breaker {
  allow(): boolean;
  success(): void;
  failure(): void;
  isOpen(): boolean;
}
export function signatureExpiry(headers: Headers): number;
export function createStaleStore(options?: { maxEntries?: number; maxBytes?: number }): StaleStore;
export function createBreaker(options?: { failures?: number; windowMs?: number; now?: () => number }): Breaker;
export function fetchWithDeadline(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response>;
export function serveWithFallback(options: {
  decision: Extract<Decision, { serve: true }>;
  request: Request;
  config: AdapterConfig;
  fetchImpl?: typeof fetch;
  fetchInit?: RequestInit;
  next?: ((request: Request) => Promise<Response>) | null;
  staleStore?: StaleStore;
  breaker?: Breaker;
  timeoutMs?: number;
  now?: () => number;
}): Promise<Response>;
export function memoryStore(): ManifestStore;

export function mergeVary(existing: string | null | undefined): string;
export function clientAddress(request: Request, config?: AdapterConfig): string;
export function connectorKeyOf(config?: AdapterConfig): { kty: string; crv: string; x: string; d: string; kid: string } | null;
export function forwardingHeaders(decision: Extract<Decision, { serve: true }>, request: Request, config?: AdapterConfig, now?: () => number): Promise<Headers>;
export function fetchSigned(decision: Extract<Decision, { serve: true }>, request: Request, fetchImpl?: typeof fetch, extraInit?: RequestInit, config?: AdapterConfig): Promise<Response>;
export function handleRequest(options: {
  request: Request;
  config: AdapterConfig;
  manifestCache?: ManifestCache | null;
  fetchImpl?: typeof fetch;
  next: (request: Request) => Promise<Response>;
  fetchInit?: RequestInit;
  staleStore?: StaleStore;
  breaker?: Breaker;
  timeoutMs?: number;
}): Promise<Response>;
export function configFromEnv(env?: Record<string, string | undefined>): AdapterConfig;
