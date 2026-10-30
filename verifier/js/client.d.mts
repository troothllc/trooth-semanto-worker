// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC

export const TROOTH_API: string;
export const DOH_ENDPOINT: string;

export interface SemantoRead {
  ok: boolean;
  reason: string | null;
  status: number;
  text: string;
  version: string | null;
  signed_by: string | null;
  keyid: string | null;
  /** True when the domain's _trooth-keys TXT record names the signing key; null when DNS could not be asked or a witness signed. */
  dns: boolean | null;
  checks: { name: string; ok: boolean; detail: string }[];
  notes: string[];
}

export class SemantoClient {
  constructor(opts?: { fetch?: typeof fetch; apiBase?: string; doh?: string | null; cacheSeconds?: number; now?: () => number });
  read(url: string, opts?: { accept?: string }): Promise<SemantoRead>;
  facts(troothId: string): Promise<SemantoRead & { data: unknown }>;
  keysFor(domain: string): Promise<{ keys: { company: { keys: unknown[] }; trooth: { keys: unknown[] } }; notes: string[] }>;
  dnsKids(domain: string): Promise<string[] | null>;
}
