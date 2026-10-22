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
}

export interface ManifestPage {
  id: string;
  url: string;
  hash?: string;
  title?: string;
}

export type Manifest = unknown;

export type Decision =
  | { serve: true; url: string; kind: "well_known" | "llms" | "facts" | "page" | "page_lookup"; representation: Representation | null; page?: ManifestPage }
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
}
export function createManifestCache(options: {
  config: AdapterConfig;
  fetchImpl?: typeof fetch;
  store?: ManifestStore;
  ttlSeconds?: number;
  now?: () => number;
}): ManifestCache;
export function memoryStore(): ManifestStore;

export function fetchSigned(decision: Extract<Decision, { serve: true }>, request: Request, fetchImpl?: typeof fetch, extraInit?: RequestInit): Promise<Response>;
export function handleRequest(options: {
  request: Request;
  config: AdapterConfig;
  manifestCache?: ManifestCache | null;
  fetchImpl?: typeof fetch;
  next: (request: Request) => Promise<Response>;
  fetchInit?: RequestInit;
}): Promise<Response>;
export function configFromEnv(env?: Record<string, string | undefined>): AdapterConfig;
