// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The setup flow behind the six-screen wizard (docs/spec/setup-api.md,
// docs/audit/workflow-research.md sections 5 and 6), over the pipeline's
// ports:
//
//   claim      a worker-f session with no company yet claims the domain it
//              names: the company row is created (or an unlinked row is
//              linked) with os_company_id and the owner; the domain is fixed
//              from then on; a domain linked to another workspace is refused
//   start      the claim, then at once a read of the public site in held
//              mode (stored, not published, not witnessed)
//   prove      every poll looks the proof record up again (at most once in
//              10 seconds), at _trooth-challenge.<domain> on two resolvers and
//              in the well-known file; the find is recorded against the
//              company's own domain and promotes the held read
//   state      the step, the proof with its plain diagnosis and the DNS host's
//              steps, the read with its receipt in plain words, review, sign,
//              install and monitoring, the measured timings and the next action
//   install    the automatic three-part check of the company's own site
//
// The server, not the browser, decides what is done (Stripe hosted
// onboarding), and every state survives the owner leaving (save for later).

import { digest } from "./core/hash";
import { isTroothId } from "./core/ids";
import { registrableDomain } from "./compiler/url";
import type { BuildRow } from "./compiler/stream";
import { claim, cleanDomain, dnsClaimName, measureSetup, newChallenge, pointerRecordName, pointerRecordValue, wellKnownClaimUrl, CHALLENGE_RE, type SetupStepId } from "./basic/tier";
import { currentKey } from "./identity/keys";
import { HOST_GUIDES, HOST_KINDS, DEFAULT_SETTINGS, type HostKind } from "./settings/delivery";
import { questionsFor } from "./gap/prompts";
import { diagnose, exactFound, type Diagnosis, type ResolverAnswer } from "./setup/dns-diagnosis";
import { hostFromNameservers, manualSteps, UNKNOWN_HOST } from "./setup/dns-hosts";
import { applyUrl, discover as discoverDomainConnect } from "./setup/domain-connect";
import { runInstallCheck, type InstallCheckResult } from "./setup/install-check";
import { decideStep, etaSeconds, leftOutPlain, LONG_READ_MS, newSetupRecord, nextAction, reviewSections, DETECT_INTERVAL_MS, DNS_CHECK_INTERVAL_MS, type LeftOutCode, type NextAction, type SetupRecord, type SetupStep } from "./setup/state";
import { isDomainProven, type CompanyRecord, type WorkspaceAction, type WorkspaceAuth, type WorkspaceResult, type WorkspaceSession } from "./serve/ports";
import type { ProblemCode } from "./serve/errors";
import type { Pipeline } from "./pipeline";

const iso = (d: Date) => d.toISOString();
const ok = (status: number, body: unknown): WorkspaceResult => ({ status, body });
const problem = (code: ProblemCode, detail: string): WorkspaceResult => ({ status: 0, problem: { code, detail } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const mayAdminister = (ws: WorkspaceAuth) => ws.role === "owner" || ws.role === "admin";
const mayOperate = (ws: WorkspaceAuth) => ws.role !== "viewer";
const VIEWER_ONLY = "A workspace viewer can read but cannot change setup. Ask an owner, admin or member.";

/** Trooth IDs never given: they collide with fixed routes. */
export const RESERVED_TROOTH_IDS = new Set(["setup", "claim", "log", "verify", "first-publication", "keys", "revocations", "well-known", "catalogs", "os", "public"]);

/** The address the wizard and the emails link to. */
export const SETUP_PAGE_URL = "https://trooth.co/dashboard/semanto/setup";

// ---------------------------------------------------------------- the document the wizard reads

export interface SetupDoc {
  object: "semanto.setup";
  trooth_id: string | null;
  org: string | null;
  domain: string | null;
  step: SetupStep;
  basic: boolean;
  saved_for_later: boolean;
  proof: {
    record_type: "TXT";
    record_name: string;
    name_to_type: string;
    record_value: string;
    status: "waiting" | "found_wrong_value" | "found" | "proved";
    checked_at: string | null;
    next_check_at: string | null;
    proven_at: string | null;
    method: "dns_txt" | "well_known" | null;
    provider: { id: string; name: string; domain_connect_url?: string; manual_steps: string[] };
    diagnosis: Diagnosis;
    well_known: { url: string; body: string };
    pointer: { record_name: string; record_value: string | null };
  } | null;
  read: {
    status: "queued" | "reading" | "done" | "failed";
    held: boolean;
    found: number;
    read: number;
    pages_done: number;
    left_out: { url: string; reason: string; code: LeftOutCode }[];
    eta_seconds?: number;
    started_at: string | null;
    finished_at?: string;
    error?: string;
    version: number | null;
  } | null;
  review: { version: number | null; root_hash: string | null; changed_since_read: boolean; changed_urls: string[]; facts_count: number; pages_count: number; saved_for_later: boolean; confirmed_at: string | null } | null;
  sign: { custody: "hosted" | "customer"; passkey_required: boolean; /** The signed-in person has a passkey on file (hosted signing needs one). */ has_passkey: boolean; two_officer: boolean; approvals: { name: string; role: string; at: string; passkey: boolean }[]; signed_version: number | null; signed_at: string | null } | null;
  install: { host: HostKind; guide_id: string; detected_at: string | null; checks: InstallCheckResult["checks"]; message: string; checked_at: string | null } | null;
  monitoring: { started_at: string | null; questions: string[]; competitors: { name: string; domain: string }[]; suggested_questions: string[] } | null;
  timings: ReturnType<typeof measureSetup>;
  next_action: NextAction | null;
  checked_at: string;
}

const osBase = (p: Pipeline) => p.d.config.public_api_base.replace(/\/public\//, "/os/");

function companyStepDoc(p: Pipeline): SetupDoc {
  const now = iso(p.d.now());
  return {
    object: "semanto.setup",
    trooth_id: null,
    org: null,
    domain: null,
    step: "company",
    basic: true,
    saved_for_later: false,
    proof: null,
    read: null,
    review: null,
    sign: null,
    install: null,
    monitoring: null,
    timings: measureSetup(now, {}),
    next_action: nextAction("company", { osBase: osBase(p), trooth_id: null, readDone: false, confirmed: false, installPassed: false }),
    checked_at: now,
  };
}

// ---------------------------------------------------------------- the setup record

/** The setup record for a company, created on first contact with a fresh proof value. */
export async function ensureSetup(p: Pipeline, company: CompanyRecord, who: { user_id: string; email: string | null; signed_in_at: string | null }): Promise<SetupRecord> {
  const existing = await p.d.store.getSetup(company.trooth_id);
  if (existing) return existing;
  const now = iso(p.d.now());
  const basic = await p.d.store.getBasic(company.trooth_id);
  const challenge = basic && CHALLENGE_RE.test(basic.claim_token) && basic.domain === company.domain ? basic.claim_token : newChallenge(p.random(24));
  const record = newSetupRecord(company.trooth_id, now, challenge, who.email, who.signed_in_at);
  record.steps.company = now;
  if (isDomainProven(company)) record.steps.prove_domain = company.domain_proven_at!;
  await p.d.store.putSetup(record);
  if (!basic || basic.claim_token !== challenge) await p.d.store.putBasic({ ...claim(company.trooth_id, company.domain, challenge, p.d.now()), ...(isDomainProven(company) ? { state: "domain_proved" as const, domain_proved_at: company.domain_proven_at! } : {}) });
  return record;
}

/** Record when a step finished, the first time only. */
export async function stampStep(p: Pipeline, trooth_id: string, step: SetupStepId, at: string): Promise<void> {
  const s = await p.d.store.getSetup(trooth_id);
  if (!s || s.steps[step]) return;
  await p.d.store.putSetup({ ...s, steps: { ...s.steps, [step]: at } });
}

// ---------------------------------------------------------------- claim (finding 1)

/** The Trooth ID for a new company: worker-f's slug when free, else the first label of the registrable domain, else the host with hyphens, then numbered. */
export async function chooseTroothId(p: Pipeline, domain: string, slug: string | null): Promise<string> {
  const free = async (id: string) => isTroothId(id) && !RESERVED_TROOTH_IDS.has(id) && !(await p.d.store.getCompany(id));
  if (slug && (await free(slug))) return slug;
  const label = registrableDomain(domain).split(".")[0] ?? domain;
  if (await free(label)) return label;
  const hyphen = domain.replace(/\./g, "-").slice(0, 60);
  if (await free(hyphen)) return hyphen;
  for (let n = 2; n < 1000; n++) {
    const id = `${hyphen.slice(0, 56)}-${n}`;
    if (await free(id)) return id;
  }
  throw new Error("chooseTroothId: no free id");
}

type ClaimOutcome = { ok: true; company: CompanyRecord; created: boolean; owner: boolean } | { ok: false; result: WorkspaceResult };

/** Create or link the company for a session. The domain is fixed here and never taken from a later request. */
export async function claimCompany(p: Pipeline, s: WorkspaceSession, body: Record<string, unknown>, requireOrg: boolean): Promise<ClaimOutcome> {
  const rawDomain = str(body.domain);
  const domain = rawDomain ? cleanDomain(rawDomain) : null;
  if (!domain) return { ok: false, result: problem("invalid_request", "Send the website as domain, for example acme.com.") };
  const org = str(body.org);
  if (requireOrg && !org) return { ok: false, result: problem("invalid_request", "Send the company name as org.") };
  if (org && org.length > 200) return { ok: false, result: problem("invalid_request", "Keep the company name under 200 characters.") };
  const mine = await p.d.store.getCompanyByOsCompany(s.os_company_id);
  if (mine) {
    if (mine.domain !== domain) return { ok: false, result: problem("domain_fixed", `This workspace set up Semanto for ${mine.domain}. The domain was fixed then and cannot change to ${domain}.`) };
    return { ok: true, company: mine, created: false, owner: (await p.d.store.ownerUserId(mine.trooth_id)) === s.user_id };
  }
  const elsewhere = `${domain} is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim.`;
  const holder = await p.d.store.getCompanyByDomain(domain);
  if (holder) {
    if (holder.os_company_id && holder.os_company_id !== s.os_company_id) return { ok: false, result: problem("domain_claimed_elsewhere", elsewhere) };
    // A row nobody claimed yet (created before workspace links existed): the first workspace links it, and still has to prove the domain.
    await p.d.store.linkOsCompany(holder.trooth_id, s.os_company_id);
    await p.d.store.registerOwner(holder.trooth_id, s.user_id);
    const linked = (await p.d.store.getCompany(holder.trooth_id))!;
    if (linked.os_company_id !== s.os_company_id) return { ok: false, result: problem("domain_claimed_elsewhere", elsewhere) };
    return { ok: true, company: linked, created: false, owner: (await p.d.store.ownerUserId(linked.trooth_id)) === s.user_id };
  }
  const trooth_id = await chooseTroothId(p, domain, s.company_slug);
  try {
    await p.d.store.putCompany({ trooth_id, domain, org: org ?? domain, tier: "basic", current_version: null, custody: "hosted", domain_proven_at: null, os_company_id: s.os_company_id });
  } catch {
    // Two claims at once: the domain is unique, so the second insert fails. Whoever holds it now answers.
    const now = await p.d.store.getCompanyByDomain(domain);
    if (now && now.os_company_id !== s.os_company_id) return { ok: false, result: problem("domain_claimed_elsewhere", elsewhere) };
    if (!now) throw new Error("claim: the company row was not written");
  }
  await p.d.store.linkOsCompany(trooth_id, s.os_company_id);
  await p.d.store.registerOwner(trooth_id, s.user_id);
  return { ok: true, company: (await p.d.store.getCompany(trooth_id))!, created: true, owner: true };
}

/** The claim routes: GET /os/semanto/setup, POST /os/semanto/claim, POST /os/semanto/setup/start. */
export async function setupSession(p: Pipeline, what: "claim" | "setup/start" | "setup", s: WorkspaceSession, body: Record<string, unknown>): Promise<WorkspaceResult> {
  const who = { user_id: s.user_id, email: s.email, signed_in_at: s.signed_in_at };
  if (what === "setup") {
    const company = await p.d.store.getCompanyByOsCompany(s.os_company_id);
    if (!company) return ok(200, companyStepDoc(p));
    await ensureSetup(p, company, who);
    return ok(200, await setupState(p, company.trooth_id, { live: true, user_id: s.user_id }));
  }
  const outcome = await claimCompany(p, s, body, what === "setup/start");
  if (!outcome.ok) return outcome.result;
  const { company, created } = outcome;
  const setup = await ensureSetup(p, company, who);
  if (what === "claim") return ok(created ? 201 : 200, { object: "semanto.claim", trooth_id: company.trooth_id, domain: company.domain, org: company.org, created, owner: outcome.owner });
  // Start reading at once: the public site is public, so the read runs during the proof and is held until it.
  if (!setup.build_id) {
    const build_id = await p.queueBuild({ trooth_id: company.trooth_id, domain: company.domain, reason: "setup", requested_at: iso(p.d.now()) });
    const fresh = (await p.d.store.getSetup(company.trooth_id))!;
    await p.d.store.putSetup({ ...fresh, build_id });
  }
  return ok(created ? 201 : 200, await setupState(p, company.trooth_id, { live: false, user_id: s.user_id }));
}

// ---------------------------------------------------------------- the proof (finding 2)

export interface ProofCheck {
  proven: boolean;
  /** True when this call found the record and recorded the proof. */
  justProven: boolean;
  method: "dns_txt" | "well_known" | null;
  challenge: string;
  claimed_at: string;
}

/**
 * Look the proof record up for the company's own domain and record the proof
 * when it is there. At most one lookup in 10 seconds per company unless
 * forced. Proof promotes the held read, or queues a read when none exists.
 */
export async function checkProof(p: Pipeline, company: CompanyRecord, opts: { force: boolean; background?: boolean }): Promise<ProofCheck> {
  let setup = await ensureSetup(p, company, { user_id: "", email: null, signed_in_at: null });
  const base = { challenge: setup.challenge, claimed_at: setup.steps.company ?? setup.started_at };
  if (isDomainProven(company)) return { ...base, proven: true, justProven: false, method: null };
  const now = p.d.now();
  if (!opts.force && setup.last_check && now.getTime() - Date.parse(setup.last_check.at) < DNS_CHECK_INTERVAL_MS) return { ...base, proven: false, justProven: false, method: null };
  const name = dnsClaimName(company.domain);
  const resolvers = p.d.setupDns?.resolvers ?? [{ name: "dns", txt: (n: string) => p.d.domainProof.dnsTxt(n) }];
  const answers: ResolverAnswer[] = [];
  for (const r of resolvers) {
    try {
      answers.push({ resolver: r.name, found: await r.txt(name), doubled: await r.txt(`${name}.${company.domain}`) });
    } catch {
      answers.push({ resolver: r.name, found: [], doubled: [], error: true });
    }
  }
  let wellKnown: string | null = null;
  try {
    wellKnown = await p.d.domainProof.fetchText(wellKnownClaimUrl(company.domain));
  } catch {
    wellKnown = null;
  }
  setup = { ...setup, last_check: { at: iso(now), resolvers: answers, well_known: wellKnown } };
  await p.d.store.putSetup(setup);
  const found = exactFound({ expected: { name, value: setup.challenge }, resolvers: answers, wellKnown });
  if (!found.found || !found.method) return { ...base, proven: false, justProven: false, method: null };
  await recordProof(p, company, found.method, iso(now), opts.background === true);
  return { ...base, proven: true, justProven: true, method: found.method };
}

async function recordProof(p: Pipeline, company: CompanyRecord, method: "dns_txt" | "well_known", at: string, background: boolean): Promise<void> {
  await p.d.store.markDomainProven(company.trooth_id, at, method);
  await stampStep(p, company.trooth_id, "prove_domain", at);
  const basic = await p.d.store.getBasic(company.trooth_id);
  if (basic) await p.d.store.putBasic({ ...basic, state: basic.state === "claim" ? "domain_proved" : basic.state, domain_proved_at: at, proof_method: method });
  const proven = (await p.d.store.getCompany(company.trooth_id))!;
  const setup = (await p.d.store.getSetup(company.trooth_id))!;
  const build = setup.build_id ? await p.staging.getBuild(setup.build_id) : await p.staging.latestBuild(company.trooth_id);
  if (build && build.status === "done") await p.promote(proven, build);
  else if (!build || build.status === "failed") {
    const build_id = await p.queueBuild({ trooth_id: company.trooth_id, domain: company.domain, reason: "setup", requested_at: at });
    const s = (await p.d.store.getSetup(company.trooth_id))!;
    await p.d.store.putSetup({ ...s, build_id });
  }
  // An owner who left the page hears that the record was found.
  if (background && setup.owner_email && !setup.proof_emailed && p.d.monitor.email && p.d.monitor.from) {
    const text = `Trooth found your record. You proved control of ${company.domain}. Keep the record in place: Trooth looks again every day.\n\nSee where setup stands: ${SETUP_PAGE_URL}\n`;
    await p.d.monitor.email.send({ from: p.d.monitor.from, to: [setup.owner_email], subject: `You proved control of ${company.domain}`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
    const s = (await p.d.store.getSetup(company.trooth_id))!;
    await p.d.store.putSetup({ ...s, proof_emailed: true });
  }
}

// ---------------------------------------------------------------- the state

async function providerFor(p: Pipeline, company: CompanyRecord, setup: SetupRecord): Promise<SetupRecord["provider"]> {
  if (setup.provider) return setup.provider;
  let host = UNKNOWN_HOST;
  if (p.d.setupDns) {
    try {
      host = hostFromNameservers(await p.d.setupDns.ns(company.domain)) ?? UNKNOWN_HOST;
    } catch {
      host = UNKNOWN_HOST;
    }
  }
  const provider = { id: host.id, name: host.name, where: host.where, checked_at: iso(p.d.now()) };
  await p.d.store.putSetup({ ...setup, provider });
  return provider;
}

/** The one-click link, only for a provider that onboarded the template, and only once a key id fills the pointer record. */
async function domainConnectUrl(p: Pipeline, company: CompanyRecord, setup: SetupRecord): Promise<string | undefined> {
  const dc = p.d.domainConnect;
  if (!dc || !dc.privateKeyPem) return undefined;
  const found = await discoverDomainConnect(company.domain, dc.discovery);
  if (!found || !found.onboarded) return undefined;
  const key = currentKey((await p.d.store.keys(company.trooth_id)).map((k) => k.public_jwk).filter((k) => !k.exp && !k.revoked_at), p.d.now());
  if (!key) return undefined;
  const state = (await digest(`${company.trooth_id}\n${setup.challenge}`)).slice(7, 39);
  return applyUrl({ urlSyncUX: found.urlSyncUX, domain: company.domain, challenge: setup.challenge, tid: company.trooth_id, fp: key.kid, redirectUri: dc.redirectUri ?? SETUP_PAGE_URL, state, privateKeyPem: dc.privateKeyPem });
}

async function changedSinceRead(p: Pipeline, trooth_id: string, file: { header: { built_at: string; pages_manifest: { url: string; source_hash: string }[] } }): Promise<string[]> {
  const state = await p.d.store.changeState(trooth_id);
  const out = new Set<string>();
  for (const page of file.header.pages_manifest) {
    const row = state[page.url];
    if (row && row.raw_hash && row.raw_hash !== page.source_hash && row.checked_at > file.header.built_at) out.add(page.url);
  }
  return [...out];
}

/** opts.user_id: the signed-in person, for has_passkey (their own passkeys). */
export async function setupState(p: Pipeline, trooth_id: string, opts: { live: boolean; user_id?: string }): Promise<SetupDoc> {
  let company = await p.d.store.getCompany(trooth_id);
  if (!company) return companyStepDoc(p);
  await ensureSetup(p, company, { user_id: "", email: null, signed_in_at: null });
  let justProven = false;
  if (opts.live && !isDomainProven(company)) {
    justProven = (await checkProof(p, company, { force: false })).justProven;
    company = (await p.d.store.getCompany(trooth_id))!;
  }
  let setup = (await p.d.store.getSetup(trooth_id))!;
  const now = p.d.now();
  const proven = isDomainProven(company);

  // proof
  const provider = (await providerFor(p, company, setup))!;
  setup = (await p.d.store.getSetup(trooth_id))!;
  const name = dnsClaimName(company.domain);
  const diagnosis = diagnose({
    domain: company.domain,
    expected: { name, value: setup.challenge },
    resolvers: setup.last_check?.resolvers ?? [],
    wellKnown: setup.last_check?.well_known ?? null,
    previousValues: setup.previous_challenges,
    lookingSince: setup.looking_since,
    provenAt: company.domain_proven_at ?? null,
    claimedByAnotherWorkspace: false,
    now: now.getTime(),
  });
  const status: NonNullable<SetupDoc["proof"]>["status"] = proven ? (justProven ? "found" : "proved") : ["wrong_value", "doubled_name", "old_value"].includes(diagnosis.state) ? "found_wrong_value" : "waiting";
  const dcUrl = proven ? undefined : await domainConnectUrl(p, company, setup);
  const keys = (await p.d.store.keys(trooth_id)).map((k) => k.public_jwk);
  const current = currentKey(keys.filter((k) => !k.exp && !k.revoked_at), now);
  const basicRow = await p.d.store.getBasic(trooth_id);
  const proof: SetupDoc["proof"] = {
    record_type: "TXT",
    record_name: name,
    name_to_type: name.slice(0, -(company.domain.length + 1)),
    record_value: setup.challenge,
    status,
    checked_at: setup.last_check?.at ?? null,
    next_check_at: proven ? null : setup.last_check ? iso(new Date(Date.parse(setup.last_check.at) + DNS_CHECK_INTERVAL_MS)) : iso(now),
    proven_at: company.domain_proven_at ?? null,
    method: proven ? (basicRow?.proof_method ?? null) : null,
    provider: { id: provider.id, name: provider.name, ...(dcUrl ? { domain_connect_url: dcUrl } : {}), manual_steps: manualSteps({ id: provider.id, name: provider.name, where: provider.where }, name, company.domain) },
    diagnosis,
    well_known: { url: wellKnownClaimUrl(company.domain), body: setup.challenge },
    pointer: { record_name: pointerRecordName(company.domain), record_value: current ? pointerRecordValue(trooth_id, current.kid) : null },
  };

  // read
  const build: BuildRow | null = setup.build_id ? await p.staging.getBuild(setup.build_id) : await p.staging.latestBuild(trooth_id);
  const latest = await p.d.store.latestFile(trooth_id);
  const readStatus = build ? (build.status === "done" ? "done" : build.status === "failed" ? "failed" : build.status === "queued" ? "queued" : "reading") : latest ? "done" : "queued";
  const result = build?.state?.result;
  const leftOut = result ? result.receipt.left_out : (build?.state?.left_out ?? []);
  const read: SetupDoc["read"] = {
    status: readStatus,
    held: Boolean(build?.held) && !proven,
    found: result ? result.receipt.found : (build?.found ?? 0),
    read: result ? result.receipt.read : readStatus === "done" && latest ? new Set(latest.file.header.pages_manifest.map((x) => x.url)).size : 0,
    pages_done: build ? (readStatus === "done" ? (result?.receipt.read ?? build.fetched) : build.fetched) : 0,
    left_out: leftOutPlain(leftOut),
    started_at: build?.started_at ?? null,
    version: readStatus === "done" ? (build?.version ?? latest?.file.header.version ?? null) : null,
  };
  if (build && readStatus === "reading") {
    const eta = etaSeconds(build.fetched, build.found, build.started_at, now.getTime());
    if (eta !== undefined) read.eta_seconds = eta;
  }
  if (build?.finished_at && (readStatus === "done" || readStatus === "failed")) read.finished_at = build.finished_at;
  if (readStatus === "failed" && build?.error) read.error = build.error;

  // review and sign
  const config = await p.d.store.getConfig(trooth_id);
  const changed = latest ? await changedSinceRead(p, trooth_id, latest.file) : [];
  const review: SetupDoc["review"] = {
    version: latest?.file.header.version ?? null,
    root_hash: latest?.file.root_hash ?? null,
    changed_since_read: changed.length > 0,
    changed_urls: changed,
    facts_count: latest?.file.facts.length ?? 0,
    pages_count: latest?.file.header.pages_manifest.length ?? 0,
    saved_for_later: setup.saved_for_later,
    confirmed_at: setup.confirmed?.at ?? null,
  };
  // Hosted custody: only approvals made with a passkey count, so only those are shown.
  const approvals = latest
    ? (await p.d.store.authorizations(trooth_id, latest.file.root_hash)).filter((a) => company!.custody !== "hosted" || a.passkey !== undefined).map((a) => ({ name: a.record.name, role: a.record.role, at: a.at, passkey: a.passkey !== undefined }))
    : [];
  const has_passkey = opts.user_id ? (await p.d.store.passkeys(opts.user_id)).length > 0 : false;
  const versions = await p.d.versions.listVersions(trooth_id);
  const signedRow = company.current_version !== null ? versions.find((v) => v.version === company!.current_version) : undefined;
  const sign: SetupDoc["sign"] = { custody: company.custody, passkey_required: company.custody === "hosted", has_passkey, two_officer: config.signing.officers === "two_officer", approvals, signed_version: company.current_version, signed_at: signedRow?.signed_at ?? null };

  // install: detection on the first poll of the install step, then at most hourly
  const path = setup.path ?? (company.tier === "full" ? "full" : null);
  const preStep = decideStep({ hasCompany: true, proven, basic: company.tier === "basic", readDone: readStatus === "done", path, confirmed: setup.confirmed !== null, signed: company.current_version !== null, installPassed: false, monitoringStarted: false });
  if (opts.live && preStep === "install" && (!setup.detection || now.getTime() - Date.parse(setup.detection.at) > DETECT_INTERVAL_MS)) {
    await p.detect(trooth_id);
    setup = (await p.d.store.getSetup(trooth_id))!;
  }
  const settings = (await p.d.settings.get(trooth_id)) ?? DEFAULT_SETTINGS;
  const host: HostKind = setup.host_override ?? setup.detection?.host ?? settings.host;
  const last = setup.install;
  const installPassed = Boolean(last && last.checks.markdown === "pass" && last.checks.signature === "pass" && last.checks.well_known === "pass");
  const install: SetupDoc["install"] = {
    host,
    guide_id: HOST_GUIDES[host],
    detected_at: setup.detection?.at ?? null,
    checks: last?.checks ?? { markdown: "pending", signature: "pending", well_known: "pending" },
    message: last?.message ?? (host === "unknown" ? "We could not tell where your site runs. Pick it from the list." : "Put Semanto on your site, then Trooth checks it."),
    checked_at: last?.checked_at ?? null,
  };

  // monitoring
  const suggested = questionsFor(config.gap.kinds[0] ?? "b2b", { company: company.org, domain: company.domain, products: config.gap.products })
    .map((q) => q.text)
    .slice(0, 10);
  const monitoring: SetupDoc["monitoring"] = { started_at: setup.monitoring?.started_at ?? null, questions: setup.monitoring?.questions ?? [], competitors: setup.monitoring?.competitors ?? [], suggested_questions: suggested };

  const step = decideStep({ hasCompany: true, proven, basic: company.tier === "basic", readDone: readStatus === "done", path, confirmed: setup.confirmed !== null, signed: company.current_version !== null, installPassed, monitoringStarted: setup.monitoring !== null });
  return {
    object: "semanto.setup",
    trooth_id,
    org: company.org,
    domain: company.domain,
    step,
    basic: company.tier === "basic",
    saved_for_later: setup.saved_for_later,
    proof,
    read,
    review,
    sign,
    install,
    monitoring,
    timings: measureSetup(setup.started_at, setup.steps),
    next_action: nextAction(step, { osBase: osBase(p), trooth_id, readDone: readStatus === "done", confirmed: setup.confirmed !== null, installPassed, custody: company.custody, hasPasskey: has_passkey, provider: { name: provider.name, ...(dcUrl ? { domain_connect_url: dcUrl } : {}) } }),
    checked_at: iso(now),
  };
}

/** GET /os/semanto/{id}/setup/review: the facts in four sections, each with the page it came from. */
export async function setupReview(p: Pipeline, trooth_id: string): Promise<WorkspaceResult> {
  const latest = await p.d.store.latestFile(trooth_id);
  if (!latest) return problem("conflict", "Nothing has been read yet. Wait for the read to finish.");
  const titles = new Map(latest.file.header.pages_manifest.map((x) => [x.url, x.title] as const));
  const changed = await changedSinceRead(p, trooth_id, latest.file);
  return ok(200, {
    object: "semanto.setup_review",
    trooth_id,
    version: latest.file.header.version,
    root_hash: latest.file.root_hash,
    changed_since_read: changed.length > 0,
    changed_urls: changed,
    sections: reviewSections(latest.file.facts, titles),
    pages: latest.file.header.pages_manifest.filter((x) => !x.part || x.part.n === 1).map((x) => ({ id: x.id, url: x.url, title: x.title })),
  });
}

// ---------------------------------------------------------------- the setup actions

export async function setupAction(p: Pipeline, action: WorkspaceAction, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  const company = await p.d.store.getCompany(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet. Start setup first.");
  const setup = await ensureSetup(p, company, { user_id: ws.user_id, email: ws.name.includes("@") ? ws.name : null, signed_in_at: null });
  const now = iso(p.d.now());
  const state = async (status = 200) => ok(status, await setupState(p, trooth_id, { live: false, user_id: ws.user_id }));
  switch (action) {
    case "setup/look-again": {
      if (!mayOperate(ws)) return problem("forbidden", VIEWER_ONLY);
      await p.d.store.putSetup({ ...setup, looking_since: now, last_check: null });
      return ok(200, await setupState(p, trooth_id, { live: true, user_id: ws.user_id }));
    }
    case "setup/read-again": {
      if (!mayOperate(ws)) return problem("forbidden", VIEWER_ONLY);
      const build_id = await p.queueBuild({ trooth_id, domain: company.domain, reason: "setup", requested_at: now });
      const fresh = (await p.d.store.getSetup(trooth_id))!;
      await p.d.store.putSetup({ ...fresh, build_id });
      return state();
    }
    case "setup/choose": {
      const path = body.path === "basic" || body.path === "full" ? body.path : null;
      if (!path) return problem("invalid_request", 'Send path as "basic" or "full".');
      if (path === "full" ? !mayAdminister(ws) : !mayOperate(ws)) return problem("forbidden", path === "full" ? "Only an owner or admin can move the company to signing its own record." : VIEWER_ONLY);
      if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first.`);
      const doc = await setupState(p, trooth_id, { live: false, user_id: ws.user_id });
      if (doc.read?.status !== "done") return problem("conflict", "Wait for the read to finish, then choose.");
      if (path === "full" && company.tier !== "full") await p.d.store.putCompany({ ...company, tier: "full" });
      const fresh = (await p.d.store.getSetup(trooth_id))!;
      await p.d.store.putSetup({ ...fresh, path, steps: { ...fresh.steps, read_site: fresh.steps.read_site ?? now } });
      return state();
    }
    case "setup/confirm": {
      if (!mayAdminister(ws)) return problem("forbidden", "Only an owner or admin can confirm the facts for signing.");
      const latest = await p.d.store.latestFile(trooth_id);
      if (!latest) return problem("conflict", "Nothing has been read yet.");
      const version = typeof body.version === "number" ? body.version : null;
      const root = str(body.root_hash);
      if (version === null || !root) return problem("invalid_request", "Send the version and root_hash you reviewed.");
      if (version !== latest.file.header.version || root !== latest.file.root_hash) return problem("conflict", "This version changed while you were reviewing. Review the changes, then confirm.");
      await p.d.store.putSetup({ ...setup, confirmed: { version, root_hash: root, at: now }, steps: { ...setup.steps, review: setup.steps.review ?? now } });
      return state();
    }
    case "setup/host": {
      if (!mayAdminister(ws)) return problem("forbidden", "Only an owner or admin can choose the host.");
      const host = HOST_KINDS.find((h) => h === body.host);
      if (!host) return problem("invalid_request", `host is one of ${HOST_KINDS.join(", ")}.`);
      await p.d.store.putSetup({ ...setup, host_override: host });
      return state();
    }
    case "setup/install-check": {
      if (!mayOperate(ws)) return problem("forbidden", VIEWER_ONLY);
      const result = await installCheck(p, company);
      const fresh = (await p.d.store.getSetup(trooth_id))!;
      const allPass = result.checks.markdown === "pass" && result.checks.signature === "pass" && result.checks.well_known === "pass";
      await p.d.store.putSetup({ ...fresh, install: result, steps: { ...fresh.steps, install: fresh.steps.install ?? now, ...(allPass ? { check: fresh.steps.check ?? now } : {}) } });
      return ok(200, { object: "semanto.install_check", url: result.url, checks: result.checks, messages: result.messages, message: result.message, checked_at: result.checked_at, setup: await setupState(p, trooth_id, { live: false, user_id: ws.user_id }) });
    }
    case "setup/monitoring": {
      if (!mayAdminister(ws)) return problem("forbidden", "Only an owner or admin can start monitoring.");
      const questions = Array.isArray(body.questions) ? body.questions : [];
      const competitorsIn = Array.isArray(body.competitors) ? body.competitors : [];
      if (questions.length > 10 || questions.some((q) => typeof q !== "string" || !q.trim() || q.length > 300)) return problem("invalid_request", "Send at most 10 questions, each a sentence under 300 characters.");
      if (competitorsIn.length > 3) return problem("invalid_request", "Send at most 3 companies to compare.");
      const competitors: { name: string; domain: string }[] = [];
      for (const c of competitorsIn) {
        const name = isRecord(c) ? str(c.name) : undefined;
        const domain = isRecord(c) && str(c.domain) ? cleanDomain(str(c.domain)!) : null;
        if (!name || !domain) return problem("invalid_request", 'Each company to compare needs a name and a domain: { "name": "Beta Ltd", "domain": "beta.example" }.');
        competitors.push({ name, domain });
      }
      const config = await p.d.store.getConfig(trooth_id);
      await p.d.store.putConfig(trooth_id, { ...config, gap: { ...config.gap, questions: questions.map((q) => (q as string).trim()), ...(competitors[0] ? { competitor: competitors[0] } : {}) } });
      await p.d.store.putSetup({ ...setup, monitoring: { started_at: now, questions: questions.map((q) => (q as string).trim()), competitors }, steps: { ...setup.steps, monitoring: setup.steps.monitoring ?? now } });
      // The first report starts at once: queued when the queue is bound.
      if (p.d.enqueue) await p.d.enqueue({ kind: "companies", job: "gap", trooth_ids: [trooth_id] });
      else await p.gapReportsFor([trooth_id]);
      return state();
    }
    case "setup/save-for-later": {
      if (!mayOperate(ws)) return problem("forbidden", VIEWER_ONLY);
      const screen = typeof body.screen === "string" && /^[A-F]$/.test(body.screen) ? body.screen : null;
      await p.d.store.putSetup({ ...setup, saved_for_later: true, saved_screen: screen, saved_at: now });
      return state();
    }
    case "setup/resume": {
      if (!mayOperate(ws)) return problem("forbidden", VIEWER_ONLY);
      await p.d.store.putSetup({ ...setup, saved_for_later: false });
      return state();
    }
    default:
      return problem("invalid_request", "No such action.");
  }
}

/** The three checks against the company's own site, with the signed copy and keys the Trooth-hosted routes serve. */
export async function installCheck(p: Pipeline, company: CompanyRecord): Promise<InstallCheckResult> {
  const file = await p.d.versions.getCurrent(company.trooth_id);
  const home = file?.header.pages_manifest.find((x) => x.url === `https://${company.domain}/` && (!x.part || x.part.n === 1)) ?? null;
  const companyJwks = await p.d.keys.getCompanyJwks(company.trooth_id);
  const trooth = await p.d.keys.getWitnessPublicKeys();
  return runInstallCheck(
    {
      domain: company.domain,
      homePageHash: home?.hash ?? null,
      pageHashes: file?.header.pages_manifest.map((x) => x.hash) ?? [],
      networkCopy: await p.networkCopy(company),
      resolveKey: (kid) => companyJwks.keys.find((k) => k.kid === kid) ?? trooth.keys.find((k) => k.kid === kid) ?? null,
      now: p.d.now(),
    },
    { fetch: (url, headers) => p.siteProbe(url, headers) },
  );
}

// ---------------------------------------------------------------- after a build: the email for a long read

export async function setupAfterBuild(p: Pipeline, build: BuildRow): Promise<void> {
  const setup = await p.d.store.getSetup(build.trooth_id);
  if (!setup || setup.build_id !== build.build_id || setup.emailed_build_id === build.build_id) return;
  const started = build.started_at ?? build.requested_at;
  const took = Date.parse(build.finished_at ?? iso(p.d.now())) - Date.parse(started);
  if (took <= LONG_READ_MS || !setup.owner_email || !p.d.monitor.email || !p.d.monitor.from) return;
  const company = await p.d.store.getCompany(build.trooth_id);
  const r = build.state?.result?.receipt;
  if (!company || !r) return;
  const left = r.left_out.length;
  const subject = `Semanto read ${r.read} of ${r.found} pages on ${company.domain}`;
  const text = `Semanto finished reading ${company.domain}. It read ${r.read} of the ${r.found} pages it found${left ? `, and left ${left} out, each with the reason` : ""}.\n\n${isDomainProven(company) ? "See what it read and choose what comes next" : `Prove you control ${company.domain} to finish`}: ${SETUP_PAGE_URL}\n`;
  await p.d.monitor.email.send({ from: p.d.monitor.from, to: [setup.owner_email], subject, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
  await p.d.store.putSetup({ ...setup, emailed_build_id: build.build_id });
}

