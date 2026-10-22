// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Content-addressed ids: a short type prefix, an underscore and the first 26
// base32 characters (130 bits) of a digest. The same object has the same id
// everywhere and forever. Registry (add here, never reuse):
//
//   smv_  a Semanto version          digest of root_hash
//   smr_  a coverage receipt         digest of the receipt
//   smp_  a page in the Pages tier   digest of the page's bytes
//   smf_  a fact                     digest of the canonical fact
//   smo_  a signed offer             digest of the canonical offer
//   smk_  a product or variant record
//   sms_  a seller attestation
//   smn_  a recall notice
//   smt_  a signed tree head         digest of the tree head
//   smd_  a read receipt
//   smb_  a first-publication record
//   smg_  a gap report                digest of the canonical report body
//   smm_  a monitor run               digest of the run
//   sma_  an alert                    digest of company, kind and key

import { DIGEST_RE } from "./hash";

export type IdPrefix = "smv" | "smr" | "smp" | "smf" | "smo" | "smk" | "sms" | "smn" | "smt" | "smd" | "smb" | "smg" | "smm" | "sma";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function hexToBase32(hex: string): string {
  let bits = "";
  for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function semantoId(prefix: IdPrefix, digest: string): string {
  if (!DIGEST_RE.test(digest)) throw new Error(`semantoId: expected "sha256:<64 hex>", got "${digest}"`);
  return `${prefix}_${hexToBase32(digest.slice(7)).slice(0, 26)}`;
}

export function isSemantoId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string") return false;
  const m = /^(smv|smr|smp|smf|smo|smk|sms|smn|smt|smd|smb|smg|smm|sma)_[a-z2-7]{26}$/.exec(value);
  return Boolean(m) && (!prefix || m![1] === prefix);
}

/** Trooth IDs are lowercase slugs, never reused. */
export function isTroothId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
