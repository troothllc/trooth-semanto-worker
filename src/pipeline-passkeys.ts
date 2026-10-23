// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The passkey steps behind hosted signing, over the pipeline's store (W3C Web
// Authentication Level 3: section 7.1 for adding a passkey, section 7.2 for
// the assertion that releases the hosted company key; the checks themselves
// are in src/identity/webauthn.ts):
//
//   passkeys/options  PublicKeyCredentialCreationOptions for the signed-in
//                     workspace user: a random 32-byte user handle kept per
//                     user, a 32-byte challenge kept five minutes for one use
//   passkeys          the new credential checked and stored (public key as a
//                     JWK, sign count, transports, created_at)
//   sign/options      PublicKeyCredentialRequestOptions with a fresh
//                     single-use challenge bound to the exact version and
//                     root hash being signed, and the user's passkeys
//   sign (hosted)     checkSigningAssertion: the assertion for that version
//                     and root hash, before the hosted key is released
//
// The device step runs on trooth.co (GitHub's passkey prompt: one device
// sheet). Customer custody is not touched: the company signs with its own key.

import { toBase64Url } from "./core/encoding";
import { readAssertion, readClientData, readRegistration, creationOptions, requestOptions, randomChallenge, verifyAssertion, verifyRegistration, CHALLENGE_TTL_MS, type PasskeyChallenge, type PasskeyUser, type WebAuthnFailure } from "./identity/webauthn";
import type { PasskeyApproval } from "./identity/roles";
import { isDomainProven, type WorkspaceAuth, type WorkspaceResult } from "./serve/ports";
import type { ProblemCode } from "./serve/errors";
import type { Pipeline } from "./pipeline";

const iso = (d: Date) => d.toISOString();
const ok = (status: number, body: unknown): WorkspaceResult => ({ status, body });
const problem = (code: ProblemCode, detail: string): WorkspaceResult => ({ status: 0, problem: { code, detail } });
const mayAdminister = (ws: WorkspaceAuth) => ws.role === "owner" || ws.role === "admin";
const osBase = (p: Pipeline) => p.d.config.public_api_base.replace(/\/public\//, "/os/");

/** The plain answer for a failed check. Nothing is signed after any of them. */
function failure(f: WebAuthnFailure, during: "add" | "sign"): WorkspaceResult {
  const nothing = during === "sign" ? " Nothing was signed." : " The passkey was not added.";
  switch (f.code) {
    case "origin":
    case "cross_origin":
      return problem("passkey_origin_mismatch", `The passkey step did not run on trooth.co: ${f.reason}.${nothing}`);
    case "challenge":
      return problem("passkey_challenge_expired", `The passkey answered an old request.${nothing} Start the passkey step again.`);
    case "counter":
      return problem("passkey_counter", `Trooth did not use this passkey: ${f.reason}.${nothing}`);
    default:
      return problem("passkey_invalid", `The passkey answer did not check out: ${f.reason}.${nothing}`);
  }
}

async function userFor(p: Pipeline, user_id: string): Promise<PasskeyUser> {
  const have = await p.d.store.passkeyUser(user_id);
  if (have) return have;
  return p.d.store.putPasskeyUser({ user_id, handle: toBase64Url(p.random(32)), created_at: iso(p.d.now()) });
}

async function newChallenge(p: Pipeline, c: Omit<PasskeyChallenge, "challenge" | "created_at" | "expires_at">): Promise<PasskeyChallenge> {
  const now = p.d.now();
  const record: PasskeyChallenge = { ...c, challenge: randomChallenge((n) => p.random(n)), created_at: iso(now), expires_at: iso(new Date(now.getTime() + CHALLENGE_TTL_MS)) };
  await p.d.store.putPasskeyChallenge(record);
  return record;
}

/** Consume the challenge the browser answered; null when it is unknown, used, for someone else, or expired. */
async function consume(p: Pipeline, clientDataJSON: string, kind: PasskeyChallenge["kind"], trooth_id: string, user_id: string): Promise<PasskeyChallenge | "unreadable" | null> {
  const cd = readClientData(clientDataJSON);
  if (!cd) return "unreadable";
  const stored = await p.d.store.takePasskeyChallenge(cd.challenge.replace(/=+$/, ""), kind, trooth_id, user_id);
  if (!stored) return null;
  if (Date.parse(stored.expires_at) <= p.d.now().getTime()) return null;
  return stored;
}

const EXPIRED = (nothing: string) => problem("passkey_challenge_expired", `The passkey request has expired or was already used.${nothing} Start the passkey step again; each request works once, for five minutes.`);

/** The detail of the "Add a signing passkey first" problem, naming the route. */
export function addPasskeyFirst(p: Pipeline, trooth_id: string): string {
  return `Add a signing passkey first. Trooth keeps your company's signing key and releases it only after you use your signing passkey, which is separate from how you sign in to trooth.co. Ask for the options at POST ${osBase(p)}/${trooth_id}/passkeys/options, create the passkey on your device, and send it to POST ${osBase(p)}/${trooth_id}/passkeys.`;
}

// ---------------------------------------------------------------- 7.1: add a passkey

/** POST /os/semanto/{id}/passkeys/options. */
export async function passkeyOptions(p: Pipeline, ws: WorkspaceAuth, trooth_id: string): Promise<WorkspaceResult> {
  const company = await p.d.store.getCompany(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet. Start setup first.");
  const user = await userFor(p, ws.user_id);
  const existing = await p.d.store.passkeys(ws.user_id);
  const c = await newChallenge(p, { kind: "create", trooth_id, user_id: ws.user_id, version: null, root_hash: null });
  return ok(200, {
    object: "semanto.passkey_options",
    trooth_id,
    expires_at: c.expires_at,
    has_passkey: existing.length > 0,
    publicKey: creationOptions({ config: p.webauthn(), user, name: ws.name, challenge: c.challenge, existing }),
    next: `Pass publicKey to navigator.credentials.create (buffers are base64url), then send the credential as { "credential": <PublicKeyCredential JSON> } to POST ${osBase(p)}/${trooth_id}/passkeys.`,
  });
}

/** POST /os/semanto/{id}/passkeys. */
export async function registerPasskey(p: Pipeline, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  const input = readRegistration(body);
  if (!input) return problem("invalid_request", "Send the credential navigator.credentials.create gave, as { \"credential\": { id, rawId, type, response: { clientDataJSON, attestationObject, transports } } }, every buffer base64url.");
  const stored = await consume(p, input.clientDataJSON, "create", trooth_id, ws.user_id);
  if (stored === "unreadable") return problem("passkey_invalid", "The browser's client data could not be read. The passkey was not added.");
  if (!stored) return EXPIRED(" The passkey was not added.");
  const user = await p.d.store.passkeyUser(ws.user_id);
  if (!user) return EXPIRED(" The passkey was not added.");
  const r = await verifyRegistration({ input, challenge: stored.challenge, config: p.webauthn() });
  if (!r.ok) return failure(r, "add");
  if (await p.d.store.getPasskey(r.passkey.credential_id)) return problem("conflict", "This passkey is already on file. Use it to sign.");
  const created_at = iso(p.d.now());
  await p.d.store.putPasskey({
    credential_id: r.passkey.credential_id,
    user_id: ws.user_id,
    trooth_id,
    public_jwk: r.passkey.public_jwk,
    alg: r.passkey.alg,
    sign_count: r.passkey.sign_count,
    transports: r.passkey.transports,
    backup_eligible: r.passkey.backup_eligible,
    backed_up: r.passkey.backed_up,
    created_at,
    last_used_at: null,
  });
  return ok(201, { object: "semanto.passkey", trooth_id, credential_id: r.passkey.credential_id, alg: r.passkey.alg, transports: r.passkey.transports, backed_up: r.passkey.backed_up, created_at });
}

// ---------------------------------------------------------------- 7.2: approve one version

/** POST /os/semanto/{id}/sign/options. */
export async function signOptions(p: Pipeline, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
  if (!mayAdminister(ws)) return problem("forbidden", `A workspace ${ws.role} cannot sign. Ask an owner or admin.`);
  const company = await p.d.store.getCompany(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first. Nothing is signed or witnessed before the proof.`);
  if (company.custody !== "hosted") return problem("conflict", "This company signs with its own key, so there is no passkey step. Ask for the signing input at POST sign.");
  const v = typeof body.version === "number" ? await p.d.store.getVersion(trooth_id, body.version) : await p.d.store.latestVersion(trooth_id);
  if (!v) return problem("conflict", "Nothing has been built yet. Build a version first.");
  if (v.file.header.state === "signed") return problem("conflict", `Version ${v.file.header.version} is already signed.`);
  if (v.file.header.state === "withdrawn") return problem("conflict", `Version ${v.file.header.version} was withdrawn.`);
  const passkeys = await p.d.store.passkeys(ws.user_id);
  if (!passkeys.length) return problem("passkey_missing", addPasskeyFirst(p, trooth_id));
  const c = await newChallenge(p, { kind: "get", trooth_id, user_id: ws.user_id, version: v.file.header.version, root_hash: v.file.root_hash });
  return ok(200, {
    object: "semanto.sign_options",
    trooth_id,
    version: v.file.header.version,
    root_hash: v.file.root_hash,
    expires_at: c.expires_at,
    publicKey: requestOptions({ config: p.webauthn(), challenge: c.challenge, passkeys }),
    next: `Pass publicKey to navigator.credentials.get (buffers are base64url), then send { "version": ${v.file.header.version}, "assertion": { id, clientDataJSON, authenticatorData, signature, userHandle } } to POST ${osBase(p)}/${trooth_id}/sign within five minutes.`,
  });
}

/**
 * Hosted custody, before the key is released: the assertion in body.assertion
 * answers this person's challenge for exactly this version and root hash.
 * The challenge is consumed whatever the outcome.
 */
export async function checkSigningAssertion(p: Pipeline, ws: WorkspaceAuth, trooth_id: string, v: { version: number; root_hash: string }, body: Record<string, unknown>): Promise<{ ok: true; approval: PasskeyApproval } | { ok: false; result: WorkspaceResult }> {
  const no = (result: WorkspaceResult) => ({ ok: false as const, result });
  const passkeys = await p.d.store.passkeys(ws.user_id);
  if (!passkeys.length) return no(problem("passkey_missing", addPasskeyFirst(p, trooth_id)));
  if (body.assertion === undefined || body.assertion === null) return no(problem("passkey_cancelled", `The passkey step did not finish, so the signing key was not released. Nothing was signed. Ask for a passkey request at POST ${osBase(p)}/${trooth_id}/sign/options and finish the step on your device.`));
  const input = readAssertion(body.assertion);
  if (!input) return no(problem("invalid_request", "assertion must carry id, clientDataJSON, authenticatorData, signature and userHandle, every buffer base64url."));
  const stored = await consume(p, input.clientDataJSON, "get", trooth_id, ws.user_id);
  if (stored === "unreadable") return no(problem("passkey_invalid", "The browser's client data could not be read. Nothing was signed."));
  if (!stored) return no(EXPIRED(" Nothing was signed."));
  if (stored.version !== v.version || stored.root_hash !== v.root_hash) {
    return no(problem("passkey_invalid", `The passkey answer was for version ${stored.version ?? "none"} with root hash ${stored.root_hash ?? "none"}, not version ${v.version} with root hash ${v.root_hash}. Nothing was signed. Start the passkey step again for this version.`));
  }
  const passkey = passkeys.find((k) => k.credential_id === input.id.replace(/=+$/, ""));
  if (!passkey) return no(problem("passkey_invalid", "The passkey used is not one of yours. Nothing was signed."));
  const user = await p.d.store.passkeyUser(ws.user_id);
  if (!user) return no(problem("passkey_missing", addPasskeyFirst(p, trooth_id)));
  const r = await verifyAssertion({ input, challenge: stored.challenge, config: p.webauthn(), passkey, user });
  if (!r.ok) return no(failure(r, "sign"));
  const checked_at = iso(p.d.now());
  // The count moves only forward, in one conditional write: of two assertions at the same count, one wins.
  if (!(await p.d.store.touchPasskey(passkey.credential_id, r.sign_count, r.backed_up, checked_at))) {
    return no(problem("passkey_counter", "Trooth did not use this passkey: another answer with the same counter was used first, which can mean the passkey was copied. Nothing was signed."));
  }
  return { ok: true, approval: { credential_id: passkey.credential_id, user_id: ws.user_id, user_handle: user.handle, checked_at } };
}
