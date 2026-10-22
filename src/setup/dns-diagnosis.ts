// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// DNS proof diagnosis: what the server found in public DNS, turned into one
// state and one plain sentence a non-technical owner can act on. Ported from
// the flows blueprint (src/lib/dns-diagnosis.ts), with one state added: a
// record one resolver sees and another does not yet is "propagating", and the
// answer names the resolvers that were asked. States follow Resend's domain
// lifecycle (pending, failed after 72 hours) and Vercel's "expected versus
// found" output; the words are Trooth's: a domain is "proven".
//
// Pure: the setup state (src/setup/state.ts) does the DNS over HTTPS reads
// and hands this function the raw answers.

export type ProofState =
  | "not_started"
  | "looking"
  | "propagating"
  | "doubled_name"
  | "wrong_value"
  | "old_value"
  | "proven"
  | "timed_out"
  | "claimed_elsewhere";

export interface ResolverAnswer {
  /** The resolver's host name, for example cloudflare-dns.com. */
  resolver: string;
  /** TXT strings at the proof name, quotes removed. */
  found: string[];
  /** TXT strings at the doubled name (<name>.<domain>.<domain>). */
  doubled: string[];
  /** True when the resolver could not be asked. */
  error?: boolean;
}

export interface LookupInput {
  domain: string;
  expected: { name: string; value: string };
  resolvers: ResolverAnswer[];
  /** The well-known file's body, or null when it was not served. */
  wellKnown: string | null;
  /** Earlier proof values issued to this company. */
  previousValues?: string[];
  /** When Trooth started looking (the claim, or Look again). */
  lookingSince: string | null;
  provenAt: string | null;
  claimedByAnotherWorkspace: boolean;
  now: number;
}

export interface Diagnosis {
  state: ProofState;
  tone: "idle" | "working" | "done" | "attention" | "stopped";
  title: string;
  detail: string;
  fix?: string;
  keep_looking: boolean;
  resolvers: { resolver: string; found: string[] }[];
}

export const LOOK_WINDOW_MS = 72 * 60 * 60 * 1000;

const norm = (s: string) => s.trim().replace(/^"+|"+$/g, "").trim();

/**
 * True when the exact value is at the proof name on every resolver that
 * answered (at least one), or in the well-known file. A record one resolver
 * sees and another does not yet is still propagating, and is not proof yet.
 */
export function exactFound(i: Pick<LookupInput, "expected" | "resolvers" | "wellKnown">): { found: boolean; method: "dns_txt" | "well_known" | null } {
  const want = norm(i.expected.value);
  const answered = i.resolvers.filter((r) => !r.error);
  if (answered.length > 0 && answered.every((r) => r.found.map(norm).includes(want))) return { found: true, method: "dns_txt" };
  if (i.wellKnown !== null && i.wellKnown.trim() === want) return { found: true, method: "well_known" };
  return { found: false, method: null };
}

export function diagnose(i: LookupInput): Diagnosis {
  const want = norm(i.expected.value);
  const resolvers = i.resolvers.map((r) => ({ resolver: r.resolver, found: r.found.map(norm) }));
  const base = { resolvers };
  const seenBy = resolvers.filter((r) => r.found.includes(want)).map((r) => r.resolver);

  if (i.claimedByAnotherWorkspace && !i.provenAt) {
    return { ...base, state: "claimed_elsewhere", tone: "attention", title: `${i.domain} is already held by another Trooth workspace`, detail: "Someone else at your company may have claimed it first. Nothing you add to DNS will change this on its own.", fix: "Ask to join that workspace, or ask Trooth to review the claim.", keep_looking: false };
  }
  if (i.provenAt || exactFound(i).found) {
    return { ...base, state: "proven", tone: "done", title: `You proved control of ${i.domain}`, detail: "Trooth found your record. Keep it in place: Trooth looks again every day.", keep_looking: false };
  }
  const doubled = i.resolvers.some((r) => r.doubled.map(norm).includes(want));
  if (doubled) {
    return { ...base, state: "doubled_name", tone: "attention", title: "Almost: your DNS host added your domain to the name twice", detail: `The record is at ${i.expected.name}.${i.domain}. Your DNS host adds ${i.domain} for you, so the Name field needs only the first part.`, fix: `Edit the record and change Name to ${i.expected.name.slice(0, -(i.domain.length + 1))}.`, keep_looking: true };
  }
  const here = [...new Set(resolvers.flatMap((r) => r.found))];
  const old = (i.previousValues ?? []).map(norm);
  if (here.some((v) => old.includes(v))) {
    return { ...base, state: "old_value", tone: "attention", title: "An older Trooth record is there instead", detail: "The value at this name is from an earlier claim that was replaced.", fix: "Replace the value with the one shown above.", keep_looking: true };
  }
  // The right value on some resolvers is propagation, not a wrong value.
  const trooth = here.filter((v) => v !== want && v.toLowerCase().startsWith("trooth"));
  const fileWrong = i.wellKnown !== null && i.wellKnown.trim().toLowerCase().startsWith("trooth") && i.wellKnown.trim() !== want;
  if (trooth.length > 0 || fileWrong) {
    const nearMiss = trooth.find((v) => v.replace(/\s+/g, "") === want.replace(/\s+/g, ""));
    return {
      ...base,
      state: "wrong_value",
      tone: "attention",
      title: "A record is there, but the value does not match",
      detail: nearMiss ? "The value has extra spaces or a line break, which DNS keeps. Paste it again with the Copy button." : "The value at this name is different from the one Trooth gave you.",
      fix: "Paste the value again using the Copy button, so nothing is retyped.",
      keep_looking: true,
    };
  }
  if (seenBy.length > 0) {
    return { ...base, state: "propagating", tone: "working", title: "Your record is on its way", detail: `${seenBy.join(" and ")} already sees it. The other resolvers will catch up, usually within minutes.`, keep_looking: true };
  }
  if (!i.lookingSince) {
    return { ...base, state: "not_started", tone: "idle", title: "Add the record. Trooth looks for it on its own", detail: "Trooth looks for it on its own while this page is open, and keeps looking for 72 hours.", keep_looking: false };
  }
  if (i.now - Date.parse(i.lookingSince) >= LOOK_WINDOW_MS) {
    return { ...base, state: "timed_out", tone: "stopped", title: "Trooth stopped looking after 72 hours", detail: "No record was found at the name above in that time.", fix: "Check the record with your DNS host, then press Look again.", keep_looking: false };
  }
  const asked = i.resolvers.filter((r) => !r.error).map((r) => r.resolver);
  return {
    ...base,
    state: "looking",
    tone: "working",
    title: "Looking for your record",
    detail: `Most hosts publish a new record within minutes. Some take a few hours. Trooth asked ${asked.length ? asked.join(" and ") : "the public resolvers"} and keeps looking. You can leave this page: Trooth emails you when it is found.`,
    keep_looking: true,
  };
}
