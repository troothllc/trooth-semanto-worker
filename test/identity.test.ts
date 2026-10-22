// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/identity: key custody and discovery, LEI binding, roles.
// Acme Inc at acme.com is a fixture. The two LEIs are public identifiers
// from the GLEIF database used only to exercise the check-digit arithmetic;
// the GLEIF record bodies below are fixtures, not readings.

import { describe, it, expect } from "vitest";
import { generateKeyPair, importPrivate, sign as rawSign, keyValidAt, findKey } from "@/core/keys";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { utf8 } from "@/core/encoding";
import { rootHash, SCHEMA_URL, type SemantoHeader } from "@/core/semanto";
import { MemoryDns, MemoryHttp, dohDns, VleiNotWired, type VleiVerifier } from "@/identity/ports";
import {
  createHostedKey,
  buildJwks,
  currentKey,
  rotateHostedKey,
  revokeKey,
  bindingStatus,
  jwksUrl,
  dnsName,
  dnsKeyRecord,
  acceptCustomerPublicKey,
  versionSigningInput,
  assembleJws,
  checkAssembledJws,
  ROTATION_OVERLAP_MS,
} from "@/identity/keys";
import { validateLei, leiCheckDigits, mod97, lookupLei, leiFacts, compareLegalName, normalizeName, recordVlei, vleiForHeader, validateVleiRef, GLEIF_BASE } from "@/identity/lei";
import { roleFromVlei, roleFromWorkspace, mayBeSigned, describeAuthorization, type Authorization } from "@/identity/roles";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function header(kid: string): SemantoHeader {
  const empty = `sha256:${"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}`;
  return {
    schema: SCHEMA_URL,
    contract: 1,
    org: "Acme Inc",
    trooth_id: "acme",
    domains: ["acme.com"],
    profile: "full",
    version: 1,
    supersedes: null,
    built_at: NOW.toISOString(),
    state: "signed",
    not_before: NOW.toISOString(),
    not_after: new Date(NOW.getTime() + 365 * DAY).toISOString(),
    witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true",
    tiers: [],
    pages_root: empty,
    facts_root: empty,
    pages_manifest: [],
    identity: { domain: "acme.com", trooth_id: "acme", key_binding: { jwks_url: jwksUrl("acme.com"), dns_record: false } },
  };
}

describe("hosted keys, the JWKS and rotation", () => {
  it("creates a hosted key with nbf and publishes it in a JWKS without the private member", async () => {
    const { record, privateJwk } = await createHostedKey("acme", NOW);
    expect(record.custody).toBe("hosted");
    expect(record.public_jwk.nbf).toBe(NOW.toISOString());
    expect(privateJwk.d).toBeTruthy();
    const jwks = buildJwks([record.public_jwk, privateJwk], NOW);
    expect(JSON.stringify(jwks)).not.toContain('"d"');
    expect(jwks.keys.every((k) => k.kty === "OKP" && k.crv === "Ed25519" && k.alg === "EdDSA" && k.use === "sig")).toBe(true);
    expect(jwksUrl("Acme.com")).toBe("https://acme.com/.well-known/trooth-keys.json");
    expect(dnsName("acme.com")).toBe("_trooth-keys.acme.com");
    expect(dnsKeyRecord(record.kid)).toBe(`v=trooth1; kid=${record.kid}`);
  });

  it("rotation keeps both keys in the JWKS for 30 days, then the old one stops being valid", async () => {
    const first = await createHostedKey("acme", new Date(NOW.getTime() - 100 * DAY));
    const rot = await rotateHostedKey("acme", first.record.public_jwk, NOW);
    expect(rot.next.record.kid).not.toBe(first.record.kid);
    expect(rot.next.record.public_jwk.nbf).toBe(NOW.toISOString());
    expect(rot.retired.exp).toBe(new Date(NOW.getTime() + ROTATION_OVERLAP_MS).toISOString());
    expect(rot.retired.kid).toBe(first.record.kid);
    expect(rot.dns_record).toBe(dnsKeyRecord(rot.next.record.kid));
    const jwks = buildJwks([rot.retired, rot.next.record.public_jwk], NOW);
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([first.record.kid, rot.next.record.kid].sort());
    // During the overlap both verify; the new key is the one that signs.
    const mid = new Date(NOW.getTime() + 10 * DAY);
    expect(keyValidAt(findKey(jwks, first.record.kid)!, mid).ok).toBe(true);
    expect(keyValidAt(findKey(jwks, rot.next.record.kid)!, mid).ok).toBe(true);
    expect(currentKey(jwks.keys, mid)?.kid).toBe(rot.next.record.kid);
    // After the overlap the old key is expired, still published for old signatures, and never current.
    const after = new Date(NOW.getTime() + 31 * DAY);
    expect(keyValidAt(findKey(jwks, first.record.kid)!, after)).toEqual({ ok: false, reason: "expired" });
    expect(buildJwks(jwks.keys, after).keys.length).toBe(2);
    expect(currentKey(jwks.keys, after)?.kid).toBe(rot.next.record.kid);
    // Revocation is honored.
    const revoked = revokeKey(rot.next.record.public_jwk, mid);
    expect(keyValidAt(revoked, after)).toEqual({ ok: false, reason: "revoked" });
    expect(buildJwks([revoked], after).keys[0]!.revoked_at).toBe(mid.toISOString());
  });
});

describe("binding status: JWKS on the domain and the DNS record", () => {
  async function setup() {
    const { record } = await createHostedKey("acme", NOW);
    const jwks = JSON.stringify(buildJwks([record.public_jwk], NOW));
    return { kid: record.kid, jwks };
  }

  it("reports domain_and_dns when both are in place", async () => {
    const { kid, jwks } = await setup();
    const http = new MemoryHttp({ "https://acme.com/.well-known/trooth-keys.json": { status: 200, headers: {}, body: jwks } });
    const dns = new MemoryDns({ "_trooth-keys.acme.com": [dnsKeyRecord(kid)] });
    const s = await bindingStatus("acme.com", kid, http, dns, NOW);
    expect(s).toMatchObject({ level: "domain_and_dns", jwks_served: true, jwks_has_kid: true, dns_record_present: true, dns_names_kid: true });
    expect(s.sentence).toBe("acme.com publishes this key at /.well-known/trooth-keys.json and names it in DNS.");
  });

  it("reports domain_only when the DNS record is absent or names another kid", async () => {
    const { kid, jwks } = await setup();
    const http = new MemoryHttp({ "https://acme.com/.well-known/trooth-keys.json": { status: 200, headers: {}, body: jwks } });
    expect((await bindingStatus("acme.com", kid, http, new MemoryDns(), NOW)).level).toBe("domain_only");
    const other = await createHostedKey("acme", NOW);
    const s = await bindingStatus("acme.com", kid, http, new MemoryDns({ "_trooth-keys.acme.com": [dnsKeyRecord(other.record.kid)] }), NOW);
    expect(s).toMatchObject({ level: "domain_only", dns_record_present: true, dns_names_kid: false });
  });

  it("reports trooth_hosted_only when the domain does not serve the JWKS, even if DNS names the kid", async () => {
    const { kid } = await setup();
    const http = new MemoryHttp({});
    const dns = new MemoryDns({ "_trooth-keys.acme.com": [dnsKeyRecord(kid)] });
    const s = await bindingStatus("acme.com", kid, http, dns, NOW);
    expect(s).toMatchObject({ level: "trooth_hosted_only", jwks_served: false, dns_names_kid: true });
    const wrongKid = new MemoryHttp({ "https://acme.com/.well-known/trooth-keys.json": { status: 200, headers: {}, body: JSON.stringify({ keys: [] }) } });
    expect((await bindingStatus("acme.com", kid, wrongKid, dns, NOW))).toMatchObject({ level: "trooth_hosted_only", jwks_served: true, jwks_has_kid: false });
    const notJson = new MemoryHttp({ "https://acme.com/.well-known/trooth-keys.json": { status: 200, headers: {}, body: "<html>" } });
    expect((await bindingStatus("acme.com", kid, notJson, dns, NOW)).level).toBe("trooth_hosted_only");
  });

  it("reads TXT records over DNS-over-HTTPS in the application/dns-json form", async () => {
    const { kid } = await setup();
    const http = new MemoryHttp({
      [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent("_trooth-keys.acme.com")}&type=TXT`]: {
        status: 200,
        headers: { "content-type": "application/dns-json" },
        body: JSON.stringify({ Status: 0, Answer: [{ name: "_trooth-keys.acme.com", type: 16, TTL: 300, data: `"v=trooth1; " "kid=${kid}"` }] }),
      },
    });
    const dns = dohDns(http);
    expect(await dns.txt("_trooth-keys.acme.com")).toEqual([`v=trooth1; kid=${kid}`]);
    expect(await dns.txt("_trooth-keys.nothing.example")).toEqual([]);
  });
});

describe("customer-held keys: public JWK in, signing input out, JWS assembled from the signature", () => {
  it("accepts a public JWK and refuses a private one or a wrong kid", async () => {
    const kp = await generateKeyPair();
    const ok = await acceptCustomerPublicKey({ kty: "OKP", crv: "Ed25519", x: kp.publicJwk.x }, NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.jwk.kid).toBe(kp.publicJwk.kid);
    const priv = await acceptCustomerPublicKey(kp.privateJwk);
    expect(priv.ok).toBe(false);
    if (!priv.ok) expect(priv.reason).toMatch(/private key/);
    const badKid = await acceptCustomerPublicKey({ ...kp.publicJwk, kid: "not-the-thumbprint" });
    expect(badKid.ok).toBe(false);
    expect((await acceptCustomerPublicKey({ kty: "EC", crv: "P-256", x: "a", y: "b" })).ok).toBe(false);
  });

  it("the client signs exactly the signing input and the assembled detached JWS verifies as a semanto-version over the header", async () => {
    const kp = await generateKeyPair();
    const h = header(kp.publicJwk.kid);
    const prepared = versionSigningInput(h, kp.publicJwk.kid, NOW);
    expect(prepared.signing_input).toBe(`${prepared.protected_b64}.${prepared.payload_b64}`);
    expect(prepared.header.typ).toBe(JWS_TYPES.semantoVersion);
    expect(prepared.header.nbf).toBe(h.not_before);
    // The client, with its own key, signs the ASCII bytes of signing_input.
    const sig = await rawSign(await importPrivate(kp.privateJwk), utf8(prepared.signing_input));
    const jws = assembleJws(prepared, sig);
    expect(jws.detached.split(".")[1]).toBe("");
    const v = await verifyJws(jws.detached, () => kp.publicJwk, { expectTyp: JWS_TYPES.semantoVersion, payload: h, at: NOW });
    expect(v.ok).toBe(true);
    expect((await checkAssembledJws(jws.detached, h, kp.publicJwk, NOW)).ok).toBe(true);
    const tampered = { ...h, org: "Acme Incorporated" };
    expect((await checkAssembledJws(jws.detached, tampered, kp.publicJwk, NOW)).ok).toBe(false);
    expect(() => assembleJws(prepared, sig.slice(0, 63))).toThrow();
    expect(await rootHash(h)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("LEI: format, check digits, GLEIF, name comparison, vLEI", () => {
  it("accepts known-good LEIs and refuses a changed character", () => {
    expect(validateLei("5493001KJTIIGC8Y1R12")).toEqual({ ok: true, lei: "5493001KJTIIGC8Y1R12" });
    expect(validateLei("529900T8BM49AURSDO55")).toEqual({ ok: true, lei: "529900T8BM49AURSDO55" });
    expect(validateLei(" 5493001kjtiigc8y1r12 ")).toEqual({ ok: true, lei: "5493001KJTIIGC8Y1R12" });
    expect(mod97("5493001KJTIIGC8Y1R12")).toBe(1);
    expect(validateLei("5493001KJTIIGC8Y1R13").ok).toBe(false);
    expect(validateLei("5493001KJTIIGC8Y1R21").ok).toBe(false);
    expect(validateLei("5493001KJTIIGC8Y1R1").ok).toBe(false);
    expect(validateLei("529900T8BM49AURSDO5A").ok).toBe(false);
    expect(validateLei("529900T8BM49AURSD055").ok).toBe(false);
    expect(leiCheckDigits("5493001KJTIIGC8Y1R")).toBe("12");
    expect(leiCheckDigits("529900T8BM49AURSDO")).toBe("55");
  });

  const gleifBody = (name: string, status = "ACTIVE", reg = "ISSUED") =>
    JSON.stringify({
      data: {
        type: "lei-records",
        id: "5493001KJTIIGC8Y1R12",
        attributes: {
          lei: "5493001KJTIIGC8Y1R12",
          entity: { legalName: { name, language: "en" }, legalAddress: { country: "US" }, headquartersAddress: { country: "US" }, status, jurisdiction: "US-DE" },
          registration: { status: reg, lastUpdateDate: "2026-01-02T00:00:00Z", nextRenewalDate: "2027-01-02T00:00:00Z" },
        },
      },
    });

  it("turns a GLEIF record into public_record facts with source GLEIF and the url", async () => {
    const url = `${GLEIF_BASE}5493001KJTIIGC8Y1R12`;
    const http = new MemoryHttp({ [url]: { status: 200, headers: {}, body: gleifBody("Acme Fixture Inc") } });
    const r = await lookupLei("5493001KJTIIGC8Y1R12", http, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({ legal_name: "Acme Fixture Inc", entity_status: "ACTIVE", registration_status: "ISSUED", active: true, legal_address_country: "US", url, read_at: NOW.toISOString() });
    const facts = await leiFacts(r.record);
    expect(facts.map((f) => f.key)).toEqual(["identity.lei", "identity.legal_name", "identity.registered_country"]);
    for (const f of facts) {
      expect(f.provenance).toBe("public_record");
      expect(f.evidence.source).toBe("GLEIF");
      expect(f.evidence.url).toBe(url);
      expect(f.id).toMatch(/^smf_[a-z2-7]{26}$/);
    }
    expect(facts[0]!.value).toBe("5493001KJTIIGC8Y1R12");
    expect(facts[0]!.schema).toEqual({ type: "Organization", property: "leiCode" });
    const lapsed = new MemoryHttp({ [url]: { status: 200, headers: {}, body: gleifBody("Acme Fixture Inc", "ACTIVE", "LAPSED") } });
    const l = await lookupLei("5493001KJTIIGC8Y1R12", lapsed, NOW);
    expect(l.ok && l.record.active).toBe(false);
    expect((await lookupLei("5493001KJTIIGC8Y1R13", http, NOW))).toMatchObject({ ok: false, reason: "bad_format" });
    expect((await lookupLei("529900T8BM49AURSDO55", http, NOW))).toMatchObject({ ok: false, reason: "not_found" });
    expect(http.calls).toContain(url);
  });

  it("compares the declared name to the registered name and says what differs", () => {
    expect(compareLegalName("Acme Inc", "Acme Inc").kind).toBe("match");
    expect(compareLegalName("ACME, Inc.", "Acme Inc").kind).toBe("match");
    expect(compareLegalName("Acme", "Acme Incorporated").kind).toBe("match_ignoring_suffix");
    expect(compareLegalName("Acme LLC", "Acme Inc")).toMatchObject({ kind: "match_ignoring_suffix" });
    const close = compareLegalName("Acme Widgets", "Acme Widgets Holdings Inc");
    expect(close.kind).toBe("close");
    expect(close.only_in_registered).toEqual(["holdings"]);
    expect(close.only_in_declared).toEqual([]);
    expect(close.sentence).toBe("The names are close but not the same: registered has holdings.");
    const diff = compareLegalName("Acme Inc", "Globex Corporation");
    expect(diff.kind).toBe("different");
    expect(diff.only_in_declared).toEqual(["acme"]);
    expect(diff.only_in_registered).toEqual(["globex"]);
    expect(diff.sentence).toMatch(/is not the registered name/);
    expect(normalizeName("Société Générale S.A.").core).toEqual(["societe", "generale"]);
    expect(compareLegalName("The Acme Company", "Acme Co.").kind).toBe("match_ignoring_suffix");
  });

  it("records a vLEI as presented, not checked, and never puts an unchecked credential in the header", async () => {
    const said = "E".padEnd(44, "A");
    const ref = { said, issuer: "E".padEnd(44, "B"), schema: "E".padEnd(44, "C") };
    const r = await recordVlei(ref, new VleiNotWired(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe("presented_not_checked");
    expect(r.record.checked_at).toBeNull();
    expect(r.record.sentence).toBe("A vLEI credential was presented. Trooth has not checked it: no KERI verifier is connected yet.");
    expect(vleiForHeader(r.record)).toBeUndefined();
    expect(validateVleiRef({ said: "short", issuer: ref.issuer, schema: ref.schema }).ok).toBe(false);
    // A real verifier, once wired, is the only way to "checked".
    const wired: VleiVerifier = { verify: async () => ({ status: "checked", checked_at: NOW.toISOString(), lei: "5493001KJTIIGC8Y1R12" }) };
    const c = await recordVlei(ref, wired, NOW);
    expect(c.ok && c.record.status).toBe("checked");
    if (c.ok) expect(vleiForHeader(c.record)).toEqual({ said, issuer: ref.issuer, checked_at: NOW.toISOString() });
    const failing: VleiVerifier = { verify: async () => ({ status: "failed", reason: "The issuer is not in the GLEIF root of trust." }) };
    const f = await recordVlei(ref, failing, NOW);
    expect(f.ok && f.record.status).toBe("failed");
    if (f.ok) expect(vleiForHeader(f.record)).toBeUndefined();
  });
});

describe("roles and the two-officer rule", () => {
  const root = `sha256:${"ab".repeat(32)}`;
  const owner = roleFromWorkspace({ user_id: "u1", name: "Ada Fixture", role: "owner", since: "2026-01-01T00:00:00.000Z" });
  const admin = roleFromWorkspace({ user_id: "u2", name: "Ben Fixture", role: "admin", since: "2026-02-01T00:00:00.000Z" });

  it("maps workspace roles and refuses members and viewers", () => {
    expect(owner.ok && owner.record).toMatchObject({ role: "owner", name: "Ada Fixture", subject: "trooth:user:u1" });
    expect(roleFromWorkspace({ user_id: "u3", name: "Cy Fixture", role: "member", since: "2026-01-01T00:00:00.000Z" }).ok).toBe(false);
  });

  it("maps a vLEI OOR credential only when its Legal Entity credential was checked", () => {
    const le = { said: "E".padEnd(44, "A"), issuer: "E".padEnd(44, "B"), schema: "E".padEnd(44, "C"), presented_at: NOW.toISOString(), status: "presented_not_checked" as const, checked_at: null, lei: null, sentence: "" };
    const cred = { kind: "OOR" as const, said: "E".padEnd(44, "D"), holder: "E".padEnd(44, "F"), person_legal_name: "Ada Fixture", official_role: "Chief Executive Officer", issued_at: "2026-03-01T00:00:00.000Z", legal_entity: le };
    expect(roleFromVlei(cred).ok).toBe(false);
    const checked = roleFromVlei({ ...cred, legal_entity: { ...le, status: "checked", checked_at: NOW.toISOString(), lei: "5493001KJTIIGC8Y1R12" } });
    expect(checked.ok && checked.record).toMatchObject({ role: "OOR", credential: cred.said, role_title: "Chief Executive Officer", subject: cred.holder });
  });

  it("two-officer: two distinct people over the same root, not one person twice, not two people over different roots", () => {
    if (!owner.ok || !admin.ok) throw new Error("fixture");
    const a1: Authorization = { record: owner.record, at: NOW.toISOString(), root_hash: root };
    const a2: Authorization = { record: admin.record, at: NOW.toISOString(), root_hash: root };
    const single = mayBeSigned(root, [a1], { officers: "single" });
    expect(single.allowed).toBe(true);
    if (single.allowed) expect(single.authorized_by).toEqual([{ role: "owner", name: "Ada Fixture" }]);
    const one = mayBeSigned(root, [a1], { officers: "two_officer" });
    expect(one).toMatchObject({ allowed: false, missing: 1 });
    if (!one.allowed) expect(one.reason).toBe("This workspace needs two people to approve a version before it is signed. Ada Fixture has approved it; one more person is needed.");
    const twice = mayBeSigned(root, [a1, { ...a1, at: "2026-10-22T13:00:00.000Z" }], { officers: "two_officer" });
    expect(twice.allowed).toBe(false);
    const otherRoot = mayBeSigned(root, [a1, { ...a2, root_hash: `sha256:${"cd".repeat(32)}` }], { officers: "two_officer" });
    expect(otherRoot.allowed).toBe(false);
    const both = mayBeSigned(root, [a1, a2], { officers: "two_officer" });
    expect(both.allowed).toBe(true);
    if (both.allowed) expect(both.authorized_by).toEqual([{ role: "owner", name: "Ada Fixture" }, { role: "admin", name: "Ben Fixture" }]);
    expect(mayBeSigned(root, [], { officers: "two_officer" })).toMatchObject({ allowed: false, missing: 2 });
    expect(describeAuthorization(a1)).toBe("Ada Fixture approved this version as workspace owner on 2026-10-22.");
  });
});
