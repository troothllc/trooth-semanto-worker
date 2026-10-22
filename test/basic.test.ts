import { describe, it, expect } from "vitest";
import { generateKeyPair, toPublic } from "@/core/keys";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { isSemantoId } from "@/core/ids";
import { digest } from "@/core/hash";
import { utf8 } from "@/core/encoding";
import { memoryDomainProof, memoryLog, type RecordBuilderPort } from "@/basic/ports";
import { claim, proveDomain, buildBasic, upgrade, basicResponse, basicHeaders, dnsClaimRecord, dnsClaimName, wellKnownClaimUrl, SETUP_CHECKLIST, measureSetup, BASIC_ENTITLEMENTS, WITNESSED_NOT_SIGNED } from "@/basic/tier";
import { createFirstPublication, verifyFirstPublication, exportDisputeStatement, leafHashOf } from "@/basic/first-publication";
import { toHeaderValue, toRobotsLines, parseRobotsSignals, parseHeaderSignals, checkContentSignalsDrift, signContentSignals, verifyContentSignals } from "@/basic/content-signals";

const NOW = new Date("2026-10-20T09:00:00Z");
const TOKEN = "fixture_claim_token_0123456789";

const builder: RecordBuilderPort = {
  async build(domain, trooth_id) {
    return { version: 1, root_hash: await digest(`${domain}/${trooth_id}`), page_count: 12, fact_count: 40, built_at: NOW.toISOString() };
  },
};

describe("Semanto Basic state machine", () => {
  it("starts at claim and refuses to build without domain proof", async () => {
    const c = claim("acme-inc", "https://Acme.com/", TOKEN, NOW);
    expect(c.state).toBe("claim");
    expect(c.domain).toBe("acme.com");
    const r = await buildBasic(c, builder, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("domain_not_proved");
      expect(r.words).toContain("Prove acme.com first");
    }
  });
  it("proves the domain by DNS TXT at _trooth.<domain>", async () => {
    const c = claim("acme-inc", "acme.com", TOKEN, NOW);
    expect(dnsClaimName("acme.com")).toBe("_trooth.acme.com");
    expect(dnsClaimRecord(TOKEN)).toBe(`v=trooth1; claim=${TOKEN}`);
    const port = memoryDomainProof({ txt: { "_trooth.acme.com": [`"${dnsClaimRecord(TOKEN)}"`] } });
    const r = await proveDomain(c, port, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe("dns_txt");
      expect(r.company.state).toBe("domain_proved");
    }
  });
  it("proves the domain by the well-known file, and reports a wrong token", async () => {
    const c = claim("acme-inc", "acme.com", TOKEN, NOW);
    expect(wellKnownClaimUrl("acme.com")).toBe("https://acme.com/.well-known/trooth-claim.txt");
    const ok = await proveDomain(c, memoryDomainProof({ files: { "https://acme.com/.well-known/trooth-claim.txt": `${TOKEN}\n` } }), NOW);
    expect(ok.ok && ok.method).toBe("well_known");
    const bad = await proveDomain(c, memoryDomainProof({ files: { "https://acme.com/.well-known/trooth-claim.txt": "someone_elses_token_0000000" } }), NOW);
    expect(!bad.ok && bad.reason).toBe("token_mismatch");
    const none = await proveDomain(c, memoryDomainProof(), NOW);
    expect(!none.ok && none.reason).toBe("no_record_found");
    if (!none.ok) expect(none.checked.dns_name).toBe("_trooth.acme.com");
  });
  it("builds in state read after proof, then upgrades only after the Trust Profile", async () => {
    const c = claim("acme-inc", "acme.com", TOKEN, NOW);
    const proved = await proveDomain(c, memoryDomainProof({ txt: { "_trooth.acme.com": [dnsClaimRecord(TOKEN)] } }), NOW);
    if (!proved.ok) throw new Error("proof failed");
    const built = await buildBasic(proved.company, builder, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.company.state).toBe("basic_built");
    expect(built.company.record?.page_count).toBe(12);
    expect(BASIC_ENTITLEMENTS.state_of_record).toBe("read");
    const twice = await buildBasic(built.company, builder, NOW);
    expect(!twice.ok && twice.reason).toBe("already_built");
    const early = upgrade(built.company, { published: false, key_kid: null }, NOW);
    expect(!early.ok && early.reason).toBe("trust_profile_incomplete");
    const up = upgrade(built.company, { published: true, key_kid: "kid-fixture" }, NOW);
    expect(up.ok && up.company.state).toBe("upgraded");
    const notBuilt = upgrade(proved.company, { published: true, key_kid: "kid-fixture" }, NOW);
    expect(!notBuilt.ok && notBuilt.reason).toBe("not_built");
  });
  it("labels every Basic response as witnessed by Trooth and not signed by the company", async () => {
    const c = claim("acme-inc", "acme.com", TOKEN, NOW);
    for (const state of ["claim", "domain_proved", "basic_built"] as const) {
      const env = basicResponse({ ...c, state }, { hello: "world" });
      expect(env.witnessed_by).toBe("Trooth");
      expect(env.signed_by_company).toBe(false);
      expect(env.record_state).toBe("read");
      expect(env.notice).toBe(WITNESSED_NOT_SIGNED);
      expect(env.notice).toContain("witnessed by Trooth and not signed by the company");
      expect(env.body).toEqual({ hello: "world" });
    }
    expect(() => basicResponse({ ...c, state: "upgraded" }, {})).toThrow();
    expect(basicHeaders()["Trooth-Signed-By-Company"]).toBe("no");
    expect(Object.keys(basicHeaders()).some((h) => /^x-/i.test(h))).toBe(false);
  });
  it("lists what Basic serves and does not, without the company signature", () => {
    expect(BASIC_ENTITLEMENTS.serves.map((s) => s.id)).toEqual(["hosted_copy", "head_tag", "competitor_report", "alerts"]);
    expect(BASIC_ENTITLEMENTS.does_not.map((s) => s.id)).toContain("company_signature");
    for (const s of [...BASIC_ENTITLEMENTS.serves, ...BASIC_ENTITLEMENTS.does_not]) expect(s.words).not.toMatch(/\b(score|verified|certified)\b/i);
  });
  it("has a ten-minute checklist whose targets sum to 600 seconds, and measures time spent from timestamps", () => {
    expect(SETUP_CHECKLIST.reduce((n, s) => n + s.target_seconds, 0)).toBe(600);
    const t = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
    const done = measureSetup(NOW.toISOString(), { enter_domain: t(20), publish_token: t(400), prove_domain: t(430), build_record: t(600), add_head_tag: t(640), first_report: t(650) });
    expect(done.steps.map((s) => s.spent_seconds)).toEqual([20, 380, 30, 170, 40, 10]);
    expect(done.steps[1]!.within_target).toBe(false);
    expect(done.total_spent_seconds).toBe(650);
    expect(done.within_ten_minutes).toBe(false);
    const partial = measureSetup(NOW.toISOString(), { enter_domain: t(20) });
    expect(partial.total_spent_seconds).toBeNull();
    expect(partial.within_ten_minutes).toBeNull();
    expect(partial.not_started).toHaveLength(5);
  });
});

describe("first-publication proof", () => {
  const markdown = "# A post\n\nThis is the text Trooth witnessed, word for word.\n";
  it("signs, appends to the log, and verifies; changed text fails", async () => {
    const { privateJwk, publicJwk } = await generateKeyPair();
    const log = memoryLog();
    const fp = await createFirstPublication({ url: "https://acme.com/blog/a-post", markdown, title: "A post", author: "Acme Inc", trooth_id: "acme-inc", witnessed_at: NOW }, privateJwk, log);
    expect(fp.record.object).toBe("semanto.first_publication");
    expect(isSemantoId(fp.record.id, "smb")).toBe(true);
    expect(fp.record.content_hash).toBe(await digest(utf8(markdown)));
    expect(fp.leaf).toEqual({ kind: "first_publication", trooth_id: "acme-inc", ref: fp.record.id, hash: fp.record.content_hash, at: NOW.toISOString() });
    expect(fp.log).toEqual({ index: 0, tree_size: 1 });
    expect(log.leaves).toHaveLength(1);
    expect(fp.leaf_hash).toBe(await leafHashOf(fp.leaf));
    const header = await verifyJws(fp.jws, () => publicJwk, { expectTyp: JWS_TYPES.firstPublication });
    expect(header.ok).toBe(true);
    const ok = await verifyFirstPublication(fp.record, fp.jws, markdown, () => publicJwk);
    expect(ok.ok).toBe(true);
    const changed = await verifyFirstPublication(fp.record, fp.jws, markdown.replace("word for word", "roughly"), () => publicJwk);
    expect(!changed.ok && changed.reason).toBe("content_changed");
    // Title and author are declared by the requester, apart from what Trooth witnessed.
    expect(fp.record.declared).toEqual({ stated_by: "requester", title: "A post", author: "Acme Inc" });
    expect(Object.keys(fp.record).sort()).toEqual(["content_hash", "declared", "id", "object", "trooth_id", "url", "witnessed_at"]);
    const tampered = await verifyFirstPublication({ ...fp.record, declared: { stated_by: "requester", title: "Another title" } }, fp.jws, markdown, () => publicJwk);
    expect(!tampered.ok && tampered.reason).toBe("id_mismatch");
    const other = await generateKeyPair();
    const wrongKey = await verifyFirstPublication(fp.record, fp.jws, markdown, () => toPublic(other.privateJwk));
    expect(!wrongKey.ok && wrongKey.reason).toBe("bad_signature");
  });
  it("exports a plain-words statement for a copying dispute", async () => {
    const { privateJwk } = await generateKeyPair();
    const fp = await createFirstPublication({ url: "https://acme.com/blog/a-post", markdown, title: "A post", trooth_id: "acme-inc", witnessed_at: NOW }, privateJwk, memoryLog());
    const text = exportDisputeStatement(fp, { log_url: "https://api.trooth.co/public/semanto/log", record_url: `https://api.trooth.co/public/semanto/first-publication/${fp.record.id}`, check_url: "https://api.trooth.co/public/semanto/first-publication/check" });
    expect(text).toContain("https://api.trooth.co/public/semanto/first-publication/check");
    expect(text).not.toContain("/verify");
    expect(text).toContain("Stated by the person who asked, not witnessed by Trooth:");
    expect(text).toContain("Trooth witnessed this text at this address on this date.");
    expect(text).toContain("Address: https://acme.com/blog/a-post");
    expect(text).toContain("public log at index 0");
    expect(text).toContain(fp.record.content_hash);
    expect(text).not.toContain("...");
    expect(text).not.toMatch(/\b(score|verified|certified)\b/i);
  });
  it("refuses a non-https address", async () => {
    const { privateJwk } = await generateKeyPair();
    await expect(createFirstPublication({ url: "http://acme.com/x", markdown, title: "x", trooth_id: "acme-inc", witnessed_at: NOW }, privateJwk)).rejects.toThrow(/https/);
  });
});

describe("signed Content Signals", () => {
  const policy = { search: true, "ai-input": true, "ai-train": false };
  it("emits the header value and the robots.txt lines from the one policy", () => {
    expect(toHeaderValue(policy)).toBe("search=yes, ai-input=yes, ai-train=no");
    const lines = toRobotsLines(policy);
    expect(lines).toContain("User-Agent: *");
    expect(lines).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no");
    expect(parseRobotsSignals(lines.join("\n"))).toEqual(policy);
    expect(parseHeaderSignals({ "Content-Signal": "AI-Train=No, search=yes" })).toEqual({ "ai-train": false, search: true });
  });
  it("detects drift between the signed policy and what the site publishes", () => {
    const same = checkContentSignalsDrift(policy, { robotsTxt: toRobotsLines(policy).join("\n"), headers: { "content-signal": toHeaderValue(policy) } });
    expect(same.matches).toBe(true);
    const drifted = checkContentSignalsDrift(policy, { robotsTxt: "User-Agent: *\nContent-Signal: ai-train=yes, search=yes, ai-input=yes\n", headers: {} });
    expect(drifted.matches).toBe(false);
    expect(drifted.robots.differs).toEqual([{ signal: "ai-train", signed: false, published: true }]);
    expect(drifted.header.present).toBe(false);
    expect(drifted.words).toContain("robots.txt differs on ai-train");
    expect(drifted.words).toContain("sends no Content-Signal header");
    const missing = checkContentSignalsDrift(policy, { robotsTxt: "User-Agent: *\nDisallow:\n", headers: { "content-signal": toHeaderValue(policy) } });
    expect(missing.robots.present).toBe(false);
    expect(missing.header.matches).toBe(true);
    expect(missing.matches).toBe(false);
  });
  it("signs the policy on its own with typ content-signals and verifies it", async () => {
    const { privateJwk, publicJwk } = await generateKeyPair();
    const { statement, jws } = await signContentSignals({ trooth_id: "acme-inc", domain: "Acme.com", policy, as_of: NOW }, privateJwk);
    expect(statement.object).toBe("semanto.content_signals");
    expect(statement.domain).toBe("acme.com");
    expect(statement.header).toBe("search=yes, ai-input=yes, ai-train=no");
    const v = await verifyContentSignals(jws, () => publicJwk, new Date("2026-10-21T00:00:00Z"));
    expect(v.ok && v.statement.policy).toEqual(policy);
    const raw = await verifyJws(jws, () => publicJwk, { expectTyp: JWS_TYPES.witness });
    expect(!raw.ok && raw.reason).toBe("wrong_type");
    const early = await verifyContentSignals(jws, () => publicJwk, new Date("2026-10-01T00:00:00Z"));
    expect(!early.ok && early.reason).toBe("not_yet_valid");
  });
});
