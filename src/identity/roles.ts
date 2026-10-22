// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Who authorized a signature. A role record names a person and the capacity
// they signed in: an Official Organizational Role or an Engagement Context
// Role from a vLEI role credential (GLEIF vLEI Ecosystem Governance
// Framework: OOR and ECR credentials), or a Trooth workspace role (owner,
// admin). The enterprise two-officer rule is the practice of dual control in
// payments and HSM operations (NIST SP 800-57 Part 2, split knowledge and
// dual control): a version is signed only when two distinct people have
// authorized it. The header's identity.authorized_by lists them. When the
// company's key is hosted by Trooth, an approval counts only when the person
// completed a fresh passkey assertion for that root hash (W3C WebAuthn Level
// 3, section 7.2; src/identity/webauthn.ts), and the entry names the passkey.

import type { Identity } from "@/core/semanto";
import type { VleiRecord } from "./lei";

export type RoleKind = "OOR" | "ECR" | "owner" | "admin";

export interface RoleRecord {
  role: RoleKind;
  /** The person's name as they chose to show it. */
  name: string;
  /** For OOR and ECR: the credential's SAID. For workspace roles: absent. */
  credential?: string;
  /** For OOR and ECR: the role text from the credential, such as "Chief Executive Officer". */
  role_title?: string;
  /** ISO 8601, since when the role holds. */
  since: string;
  /** The workspace user id or the credential holder AID; what makes two authorizations "distinct". */
  subject: string;
}

/** The fields a vLEI OOR or ECR credential carries that Trooth maps. */
export interface VleiRoleCredential {
  kind: "OOR" | "ECR";
  said: string;
  /** The holder's AID. */
  holder: string;
  person_legal_name: string;
  official_role: string;
  issued_at: string;
  /** The checked Legal Entity credential this role chains to. */
  legal_entity: VleiRecord;
}

export type RoleMapping = { ok: true; record: RoleRecord } | { ok: false; reason: string };

/** Map a vLEI role credential. It is refused unless the Legal Entity credential it chains to was checked. */
export function roleFromVlei(cred: VleiRoleCredential): RoleMapping {
  if (cred.legal_entity.status !== "checked") return { ok: false, reason: "The role credential chains to a Legal Entity credential that was not checked. It cannot authorize a signature yet." };
  if (!cred.person_legal_name || !cred.official_role) return { ok: false, reason: "The role credential names no person or no role." };
  return { ok: true, record: { role: cred.kind, name: cred.person_legal_name, credential: cred.said, role_title: cred.official_role, since: cred.issued_at, subject: cred.holder } };
}

export interface WorkspaceMember {
  user_id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  since: string;
}

/** Map a Trooth workspace member. Only owners and admins can authorize a signature. */
export function roleFromWorkspace(m: WorkspaceMember): RoleMapping {
  if (m.role !== "owner" && m.role !== "admin") return { ok: false, reason: `A workspace ${m.role} cannot authorize a signature. Ask an owner or admin.` };
  return { ok: true, record: { role: m.role, name: m.name, since: m.since, subject: `trooth:user:${m.user_id}` } };
}

// ---------------------------------------------------------------- authorizations

/**
 * The passkey assertion behind an approval: which credential, whose, and when
 * Trooth checked it. user_id is the internal workspace user (kept in the
 * approval record for the two-officer count, never published); user_handle is
 * the random WebAuthn user handle, the only person reference that goes into
 * the signed public header.
 */
export interface PasskeyApproval {
  credential_id: string;
  user_id: string;
  user_handle: string;
  checked_at: string;
}

export interface Authorization {
  record: RoleRecord;
  /** When this person approved this version. */
  at: string;
  /** What they approved: the version's root_hash. */
  root_hash: string;
  /** Hosted custody: the passkey assertion completed for this root_hash. */
  passkey?: PasskeyApproval;
}

export interface SigningPolicy {
  /** "single" for most companies; "two_officer" for enterprise workspaces. */
  officers: "single" | "two_officer";
  /** Hosted custody: only approvals that carry a passkey assertion count. */
  require_passkey?: boolean;
}

export type SigningDecision = { allowed: true; authorized_by: Identity["authorized_by"] } | { allowed: false; reason: string; missing: number };

/**
 * Decide whether a version may be signed. Two-officer: two authorizations by
 * distinct subjects over the same root_hash. One person approving twice, or
 * two people approving different hashes, does not count. With
 * require_passkey, an approval without a passkey assertion for this
 * root_hash does not count either, and two approvals by the same user
 * (through two of their passkeys) count once.
 */
export function mayBeSigned(rootHash: string, authorizations: Authorization[], policy: SigningPolicy): SigningDecision {
  const forThis = authorizations.filter((a) => a.root_hash === rootHash && (!policy.require_passkey || (a.passkey !== undefined && `trooth:user:${a.passkey.user_id}` === a.record.subject)));
  const bySubject = new Map<string, Authorization>();
  for (const a of forThis) if (!bySubject.has(a.record.subject)) bySubject.set(a.record.subject, a);
  const distinct = [...bySubject.values()];
  const need = policy.officers === "two_officer" ? 2 : 1;
  if (distinct.length < need) {
    const missing = need - distinct.length;
    const reason =
      need === 2
        ? distinct.length === 0
          ? "This workspace needs two people to approve a version before it is signed. Nobody has approved this one yet."
          : `This workspace needs two people to approve a version before it is signed. ${distinct[0]!.record.name} has approved it; one more person is needed.`
        : "Nobody has approved this version yet.";
    return { allowed: false, reason, missing };
  }
  return { allowed: true, authorized_by: distinct.map(toHeaderEntry) };
}

/** The authorized_by entry for the Semanto header identity. */
export function toHeaderEntry(a: Authorization): NonNullable<Identity["authorized_by"]>[number] {
  return { role: a.record.role, name: a.record.name, ...(a.record.credential ? { credential: a.record.credential } : {}), ...(a.passkey ? { passkey: { credential_id: a.passkey.credential_id, user_handle: a.passkey.user_handle, checked_at: a.passkey.checked_at } } : {}) };
}

/** One sentence per authorization, for the dashboard. */
export function describeAuthorization(a: Authorization): string {
  const r = a.record;
  const how = r.role === "OOR" ? `as ${r.role_title ?? "an official role"} (vLEI OOR credential)` : r.role === "ECR" ? `as ${r.role_title ?? "an engagement role"} (vLEI ECR credential)` : `as workspace ${r.role}`;
  return `${r.name} approved this version ${how} on ${a.at.slice(0, 10)}.`;
}
