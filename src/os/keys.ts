// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Signing keys, the domain binding and safe rotation (contract section 1b).
//
// Rotation is staged, the way the widely used key systems roll keys:
// GitHub's deploy keys and SSH keys are added before the old one is removed,
// AWS KMS keeps earlier key material for verification while new material
// signs, and Stripe's "roll key" gives the old key an expiry window while
// the new one goes live. Here:
//
//   start     a new key in state next, published in the JWK Set at once so
//             verifiers learn it, never used to sign; the DNS record for the
//             new kid is answered so the owner can add it ahead of time
//   confirm   with a passkey assertion as in sign (when either key is
//             hosted): next becomes active, the old key becomes retiring
//             with overlap_until = now + ROTATION_OVERLAP_MS (30 days)
//   cancel    only before confirm: the next key is revoked and listed
//   expiry    a retiring key whose overlap_until has passed reads as
//             expired wherever keys are read; no cron moves it
//
// Revoke takes a typed confirmation (the kid), refuses the only active key,
// and puts the key on the signed revocation list at once (src/pipeline.ts
// revokeKey). The binding check reads the _trooth-keys TXT record now.

import { dnsKeyRecord, parseDnsKeyRecords, type PublicJwk } from "../core/keys";
import { acceptCustomerPublicKey, createHostedKey, dnsName, jwksUrl, ROTATION_OVERLAP_MS } from "../identity/keys";
import { dohDns } from "../identity/ports";
import { keyState } from "../ledger/revocation";
import type { CompanyKey } from "../pipeline-store";
import { checkPurposeAssertion } from "../pipeline-passkeys";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { ADMIN_ONLY, audit, iso, isRecord, mayAdminister, mayOperate, OPERATOR_ONLY, ok, problem, randomId, str, type RequestContext } from "./common";
import type { OsService } from "./service";
import type { RotationRow } from "./store";

export type KeyStateWord = "active" | "next" | "retiring" | "revoked" | "expired";

/** A key's state at `now`, computed on read: a retiring key past its overlap reads as expired. */
export function keyStateOf(k: CompanyKey, now: Date): KeyStateWord {
  const j = k.public_jwk;
  if (j.revoked_at && now.getTime() >= Date.parse(j.revoked_at)) return "revoked";
  if (k.next) return "next";
  if (j.exp && now.getTime() >= Date.parse(j.exp)) return "expired";
  if (j.exp) return "retiring";
  return "active";
}

/** A rotation's state at `now`: confirmed with its overlap passed reads as completed. */
export function rotationStateOf(r: RotationRow, now: Date): "started" | "confirmed" | "completed" | "cancelled" {
  if (r.state === "confirmed" && r.overlap_until && now.getTime() >= Date.parse(r.overlap_until)) return "completed";
  return r.state;
}

/** The rotation, with the DNS record for the new key while it waits for confirm, so the screen can show it again after a reload. */
const rotationView = (r: RotationRow | null, now: Date, domain: string) => {
  if (!r) return null;
  const state = rotationStateOf(r, now);
  return { rotation_id: r.rotation_id, next_kid: r.next_kid, current_kid: r.current_kid, overlap_until: r.overlap_until, state, ...(state === "started" ? { dns_record: { name: dnsName(domain), value: dnsKeyRecord(r.next_kid) } } : {}) };
};

/** The active key: not staged, not retiring, not revoked; the newest wins. */
function activeKeys(keys: CompanyKey[], now: Date): CompanyKey[] {
  return keys.filter((k) => keyStateOf(k, now) === "active").sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** GET /os/semanto/{id}/keys. */
export async function keysView(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const now = s.now();
  const all = await s.p.d.store.keys(trooth_id);
  const revocations = await s.p.d.store.revocations(trooth_id);
  const keys = all.map((k) => {
    const state = keyStateOf(k, now);
    const sentence = state === "next" ? "This key is published so verifiers learn it. It signs once you confirm the rotation." : state === "retiring" ? `This key still checks out until ${k.public_jwk.exp}. The new key signs from now on.` : keyState(k.public_jwk, revocations, now).sentence;
    return {
      kid: k.public_jwk.kid,
      custody: k.custody,
      state,
      sentence,
      overlap_until: state === "retiring" || state === "expired" ? (k.public_jwk.exp ?? null) : null,
      created_at: k.created_at,
      ...(k.public_jwk.nbf ? { nbf: k.public_jwk.nbf } : {}),
      ...(k.public_jwk.exp ? { exp: k.public_jwk.exp } : {}),
      ...(k.public_jwk.revoked_at ? { revoked_at: k.public_jwk.revoked_at } : {}),
    };
  });
  const active = activeKeys(all, now)[0] ?? null;
  const binding = active ? await bindingOf(s, company.domain, trooth_id, active.public_jwk.kid) : null;
  return ok(200, { object: "semanto.keys", trooth_id, keys, binding, rotation: rotationView(await s.store.latestRotation(trooth_id), now, company.domain) });
}

async function bindingOf(s: OsService, domain: string, trooth_id: string, kid: string) {
  const last = await s.store.bindingCheck(trooth_id, kid);
  return { dns_name: dnsName(domain), dns_value: dnsKeyRecord(kid), found: last?.found ?? false, checked_at: last?.checked_at ?? null };
}

/** POST /os/semanto/{id}/keys/binding/check: the TXT record at _trooth-keys.<domain>, read now over DNS over HTTPS. */
export async function bindingCheck(s: OsService, ws: WorkspaceAuth, trooth_id: string): Promise<WorkspaceResult> {
  if (!mayOperate(ws.role)) return OPERATOR_ONLY("check the DNS record");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const now = s.now();
  const active = activeKeys(await s.p.d.store.keys(trooth_id), now)[0];
  if (!active) return problem("conflict", "There is no active signing key to check. Sign a version, or start and confirm a rotation, first.");
  // The setup DNS helper (src/setup/ports.ts: two public resolvers over DNS over HTTPS); found when either names the kid.
  const lookups = s.p.d.setupDns?.resolvers.length ? s.p.d.setupDns.resolvers.map((r) => (name: string) => r.txt(name)) : [(name: string) => dohDns(s.p.d.identity.http).txt(name)];
  let found = false;
  for (const txt of lookups) {
    try {
      if (parseDnsKeyRecords(await txt(dnsName(company.domain))).includes(active.public_jwk.kid)) found = true;
    } catch {
      // A resolver that fails says nothing either way.
    }
  }
  await s.store.noteBindingCheck(trooth_id, active.public_jwk.kid, found, iso(now));
  return ok(200, { dns_name: dnsName(company.domain), dns_value: dnsKeyRecord(active.public_jwk.kid), found, checked_at: iso(now) });
}

/** POST /os/semanto/{id}/keys/rotation/start. */
export async function startRotation(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change signing keys");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const custody = body.custody;
  if (custody !== "hosted" && custody !== "customer") return problem("invalid_request", 'custody is "hosted" (Trooth keeps the new key) or "customer" (send public_jwk; you keep the private key).');
  const latest = await s.store.latestRotation(trooth_id);
  if (latest && latest.state === "started") return problem("conflict", `A rotation is already started (${latest.rotation_id}). Confirm it or cancel it first.`);
  const now = s.now();
  const keys = await s.p.d.store.keys(trooth_id);
  const current = activeKeys(keys, now)[0] ?? null;
  let pub: PublicJwk;
  let priv = null;
  if (custody === "customer") {
    if (body.public_jwk === undefined) return problem("invalid_request", "Send the new Ed25519 public key as public_jwk. Generate the pair in your browser or tools and keep the private key.");
    const accepted = await acceptCustomerPublicKey(body.public_jwk, now);
    if (!accepted.ok) return problem("invalid_request", accepted.reason);
    if (keys.some((k) => k.public_jwk.kid === accepted.jwk.kid)) return problem("conflict", `The key ${accepted.jwk.kid} is already on file. Generate a new key pair for the rotation.`);
    pub = { ...accepted.jwk, nbf: iso(now) };
  } else {
    const k = await createHostedKey(trooth_id, now);
    pub = k.record.public_jwk;
    priv = k.privateJwk;
  }
  const rotation: RotationRow = { rotation_id: randomId("rot", (n) => s.random(n)), trooth_id, next_kid: pub.kid, current_kid: current?.public_jwk.kid ?? null, custody, state: "started", overlap_until: null, started_by: ws.user_id, started_at: iso(now), confirmed_at: null, cancelled_at: null };
  // The rotation is claimed first, in one conditional write, so two starts at once never publish two next keys.
  if (!(await s.store.beginRotation(rotation))) {
    const open = await s.store.latestRotation(trooth_id);
    return problem("conflict", `A rotation is already started${open ? ` (${open.rotation_id})` : ""}. Confirm it or cancel it first.`);
  }
  await s.p.d.store.putKey(trooth_id, { public_jwk: pub, custody, created_at: iso(now), next: true }, priv);
  await s.p.logKey(trooth_id, pub);
  await audit(s.store, { trooth_id, ws, action: "keys.rotation.start", target: pub.kid, before: { active_kid: rotation.current_kid }, after: { next_kid: pub.kid, custody }, ctx, at: now });
  return ok(200, {
    object: "semanto.key_rotation",
    trooth_id,
    rotation_id: rotation.rotation_id,
    state: "started",
    custody,
    next_kid: pub.kid,
    current_kid: rotation.current_kid,
    jwks_url: jwksUrl(company.domain),
    dns_record: { name: dnsName(company.domain), value: dnsKeyRecord(pub.kid) },
    // When the old key would stop signing if the rotation were confirmed now; confirm sets the real one.
    overlap_until: iso(new Date(now.getTime() + ROTATION_OVERLAP_MS)),
    next: `The new key is published now and does not sign yet. Add the DNS record if you use one, then confirm at POST ${s.osBase()}/${trooth_id}/keys/rotation/confirm.`,
  });
}

/** POST /os/semanto/{id}/keys/rotation/options: the passkey request bound to this person and this started rotation. */
export async function rotationOptions(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change signing keys");
  const rotation_id = str(body.rotation_id);
  if (!rotation_id) return problem("invalid_request", "Send the rotation_id the rotation start answered.");
  const r = await s.store.getRotation(rotation_id);
  if (!r || r.trooth_id !== trooth_id) return problem("conflict", `There is no rotation ${rotation_id} for this company.`);
  if (r.state !== "started") return problem("conflict", `Rotation ${rotation_id} is ${r.state}; only a started rotation is confirmed.`);
  return s.p.handle("sign/options", ws, trooth_id, { purpose: "key_rotation", rotation_id });
}

/** Passkey needed when either side of the rotation is a hosted key, as in sign. */
const needsPasskey = (companyCustody: "hosted" | "customer", r: RotationRow) => companyCustody === "hosted" || r.custody === "hosted";

/** POST /os/semanto/{id}/keys/rotation/confirm. */
export async function confirmRotation(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change signing keys");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const rotation_id = str(body.rotation_id);
  if (!rotation_id) return problem("invalid_request", "Send the rotation_id the rotation start answered.");
  const r = await s.store.getRotation(rotation_id);
  if (!r || r.trooth_id !== trooth_id) return problem("conflict", `There is no rotation ${rotation_id} for this company.`);
  if (r.state !== "started") return problem("conflict", `Rotation ${rotation_id} is ${r.state}; only a started rotation can be confirmed.`);
  const keys = await s.p.d.store.keys(trooth_id);
  const next = keys.find((k) => k.public_jwk.kid === r.next_kid);
  if (!next || next.public_jwk.revoked_at) return problem("conflict", "The new key of this rotation is no longer on file. Cancel it and start again.");
  if (needsPasskey(company.custody, r)) {
    const checked = await checkPurposeAssertion(s.p, ws, trooth_id, "key_rotation", rotation_id, body);
    if (!checked.ok) return checked.result;
  }
  const now = s.now();
  const overlap_until = iso(new Date(now.getTime() + ROTATION_OVERLAP_MS));
  if (!(await s.store.settleRotation(rotation_id, "confirmed", iso(now), overlap_until))) return problem("conflict", `Rotation ${rotation_id} was confirmed or cancelled by another request.`);
  const retiring = keys.filter((k) => k.public_jwk.kid !== r.next_kid && keyStateOf(k, now) === "active");
  for (const k of retiring) await s.p.d.store.putKey(trooth_id, { ...k, public_jwk: { ...k.public_jwk, exp: k.public_jwk.exp && k.public_jwk.exp < overlap_until ? k.public_jwk.exp : overlap_until } }, null);
  const { next: _staged, ...settled } = next;
  await s.p.d.store.putKey(trooth_id, settled, null);
  await audit(s.store, { trooth_id, ws, action: "keys.rotation.confirm", target: r.next_kid, before: { active_kids: retiring.map((k) => k.public_jwk.kid) }, after: { active_kid: r.next_kid, overlap_until }, ctx, at: now });
  return ok(200, { object: "semanto.key_rotation", trooth_id, rotation_id, state: "confirmed", active_kid: r.next_kid, retiring_kids: retiring.map((k) => k.public_jwk.kid), overlap_until, custody: r.custody });
}

/** POST /os/semanto/{id}/keys/rotation/cancel: only before confirm; the next key is revoked and listed. */
export async function cancelRotation(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change signing keys");
  const rotation_id = str(body.rotation_id);
  if (!rotation_id) return problem("invalid_request", "Send the rotation_id of the rotation to cancel.");
  const r = await s.store.getRotation(rotation_id);
  if (!r || r.trooth_id !== trooth_id) return problem("conflict", `There is no rotation ${rotation_id} for this company.`);
  if (r.state !== "started") return problem("conflict", `Rotation ${rotation_id} is ${r.state}. Only a rotation that is not confirmed yet can be cancelled.`);
  const now = s.now();
  if (!(await s.store.settleRotation(rotation_id, "cancelled", iso(now), null))) return problem("conflict", `Rotation ${rotation_id} was confirmed or cancelled by another request.`);
  const revoked = await s.p.revokeKey(ws, trooth_id, r.next_kid, { reason: "The key rotation was cancelled before this key signed anything." });
  if (revoked.problem) return revoked;
  await audit(s.store, { trooth_id, ws, action: "keys.rotation.cancel", target: r.next_kid, before: { next_kid: r.next_kid }, after: { revoked: r.next_kid }, ctx, at: now });
  return ok(200, { object: "semanto.key_rotation", trooth_id, rotation_id, state: "cancelled", revoked_kid: r.next_kid, revocations_url: `${s.publicBase()}/${trooth_id}/revocations` });
}

/** POST /os/semanto/{id}/keys/{kid}/revoke with the typed confirmation. */
export async function revokeKey(s: OsService, ws: WorkspaceAuth, trooth_id: string, kid: string, input: unknown, ctx: RequestContext): Promise<WorkspaceResult> {
  const body = isRecord(input) ? input : {};
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("revoke a signing key");
  if (body.confirm !== kid) return problem("invalid_request", `Type the key id to confirm: send { "confirm": "${kid}" }. A revoked key cannot be used again.`);
  const now = s.now();
  const keys = await s.p.d.store.keys(trooth_id);
  const key = keys.find((k) => k.public_jwk.kid === kid);
  if (!key) return problem("conflict", `No key ${kid} is on file for this company.`);
  const state = keyStateOf(key, now);
  if (state === "next") return problem("conflict", `Key ${kid} is the new key of a rotation that is not confirmed. Cancel the rotation instead.`);
  if (state === "active" && activeKeys(keys, now).length === 1) return problem("conflict", `Key ${kid} is your only active signing key. Start a rotation and confirm it first, then revoke this key.`);
  const reason = str(body.reason) ?? "Revoked by the company.";
  const result = await s.p.revokeKey(ws, trooth_id, kid, { reason, ...(body.compromised_at !== undefined ? { compromised_at: body.compromised_at } : {}) });
  if (result.problem) return result;
  await audit(s.store, { trooth_id, ws, action: "keys.revoke", target: kid, before: { kid, state }, after: { kid, state: "revoked", reason }, ctx, at: now });
  return result;
}

/**
 * POST /os/semanto/{id}/keys/rotate: start plus confirm in one call for API users, refused while a staged rotation is
 * open. It needs no passkey for the moves the staged confirm lets through without one (between two customer keys) and
 * for rolling the hosted key Trooth keeps (every version it signs still asks for the passkey); moving a hosted company
 * to a customer key is refused here and goes through the staged rotation, whose confirm asks for the passkey.
 */
export async function rotateNow(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("change signing keys");
  const latest = await s.store.latestRotation(trooth_id);
  if (latest && latest.state === "started") return problem("conflict", `A rotation is already started (${latest.rotation_id}). Confirm it or cancel it first.`);
  // Moving a hosted company to a key the caller holds hands the caller a signing key; the staged confirm asks for the
  // passkey for exactly that move, so the one-call form cannot skip it.
  const company = await s.company(trooth_id);
  const wantsCustomer = body.custody === "customer" || body.public_jwk !== undefined;
  if (company?.custody === "hosted" && wantsCustomer) {
    return problem("conflict", `Trooth holds this company's signing key, so moving to a key you hold needs your signing passkey. Use the staged rotation: POST ${s.osBase()}/${trooth_id}/keys/rotation/start with { "custody": "customer", "public_jwk": <your public key> }, then keys/rotation/options and keys/rotation/confirm. Nothing was changed.`);
  }
  const before = (await s.p.d.store.keys(trooth_id)).map((k) => k.public_jwk.kid);
  const result = await s.p.handle("keys/rotate", ws, trooth_id, body);
  if (result.problem) return result;
  const after = isRecord(result.body) ? result.body : {};
  await audit(s.store, { trooth_id, ws, action: "keys.rotate", target: String(after.kid ?? ""), before: { kids: before }, after: { kid: after.kid, retired: after.retired }, ctx, at: s.now() });
  return result;
}
