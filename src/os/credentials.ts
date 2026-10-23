// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// C2PA credentials in queue jobs (contract section 6). Two trigger points
// queue one message of kind "credential" per asset: a compile, for each image
// and PDF in the version's documents tier, and a write-back send, for each
// image link Google received. The job builds the c2pa-rs manifest definition
// with src/c2pa/bridge.ts (the assertions that bind the asset to the Semanto
// version and witness), stores it in R2 under
// credentials/{trooth_id}/{sha256}.c2pa and records a semanto_credentials row:
// made, failed (the asset could not be read) or skipped (not C2PA media). An
// asset that is not in the version is read once through the SSRF guard and
// hashed. Signing and embedding the manifest need c2patool or the c2pa SDK
// with a certificate outside the Worker (src/c2pa/bridge.ts SIGNING_NOTE).

import { sha256Hex } from "../core/hash";
import { semantoId } from "../core/ids";
import type { DocumentEntry, SemantoFile } from "../core/semanto";
import { buildC2paManifest, isC2paMedia, mediaTypeOf, SIGNING_NOTE } from "../c2pa/bridge";
import { isDomainProven, type WorkspaceResult } from "../serve/ports";
import type { CredentialMessage } from "../env";
import { decodeCursor, encodeCursor, iso, ok, problem } from "./common";
import type { OsService } from "./service";
import type { CredentialState } from "./store";

export const CREDENTIAL_CONTENT_TYPE = "application/json";
export const credentialKey = (trooth_id: string, sha: string): string => `credentials/${trooth_id}/${sha}.c2pa`;
const HEX64 = /^[0-9a-f]{64}$/;

/** Queue one credential job, or run it now when no queue is bound. */
export async function queueCredential(s: OsService, m: Omit<CredentialMessage, "kind">): Promise<void> {
  const msg: CredentialMessage = { kind: "credential", ...m };
  if (s.d.enqueue) await s.d.enqueue(msg);
  else await processCredential(s, msg);
}

/** The most assets one version queues: a site with more images is read in the order its pages list them. */
export const CREDENTIALS_PER_VERSION = 200;

/**
 * The images and PDFs a signed page links, on the company's own site: the
 * markdown images (![alt](url)) and links (](url)) the build wrote from <img>
 * and <a>, kept when the host is the company's domain or its www name and the
 * path is C2PA media.
 */
export function pageMediaUrls(markdown: string, domain: string): string[] {
  const hosts = new Set([domain.toLowerCase(), `www.${domain.toLowerCase().replace(/^www\./, "")}`, domain.toLowerCase().replace(/^www\./, "")]);
  const out: string[] = [];
  for (const m of markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) {
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (!hosts.has(u.hostname.toLowerCase())) continue;
    u.hash = "";
    if (isC2paMedia({ url: u.href, kind: "other" })) out.push(u.href);
  }
  return out;
}

/**
 * After a build is stored: one job per image and PDF the build read (QA-13:
 * the build never fills the documents tier, so the jobs also come from the
 * images and PDFs its signed pages link on the company's site; each is read
 * once by the job, through the SSRF guard, and hashed).
 */
export async function credentialsForVersion(s: OsService, trooth_id: string, file: SemantoFile): Promise<number> {
  const urls = new Set<string>();
  for (const d of file.documents) if (isC2paMedia(d)) urls.add(d.url);
  const company = await s.company(trooth_id);
  if (company) {
    for (const p of file.header.pages_manifest) {
      if (urls.size >= CREDENTIALS_PER_VERSION) break;
      const body = await s.p.d.store.getBody(trooth_id, file.header.version, p.id).catch(() => null);
      if (body) for (const u of pageMediaUrls(new TextDecoder().decode(body), company.domain)) urls.add(u);
    }
  }
  let n = 0;
  for (const asset_url of [...urls].slice(0, CREDENTIALS_PER_VERSION)) {
    await queueCredential(s, { trooth_id, asset_url, source: "compile", version: file.header.version });
    n++;
  }
  return n;
}

/** The queue consumer for kind "credential". */
export async function processCredential(s: OsService, m: CredentialMessage): Promise<void> {
  const now = s.now();
  const company = await s.company(m.trooth_id);
  if (!company) return;
  const file = m.version !== undefined ? await s.p.d.store.getFile(m.trooth_id, m.version) : ((await s.p.d.versions.getCurrent(m.trooth_id)) ?? (await s.p.d.store.latestFile(m.trooth_id))?.file ?? null);
  const row = (state: CredentialState, sha: string | null, kind: string, reason: string | null) => s.store.putCredential({ trooth_id: m.trooth_id, asset_url: m.asset_url, sha256: sha, kind, source: m.source, state, reason, made_at: iso(now) });
  if (!file) return row("failed", null, "unknown", "There is no version to bind the credential to yet.");
  let entry: DocumentEntry | undefined = file.documents.find((d) => d.url === m.asset_url);
  if (!entry) {
    const probe = { url: m.asset_url, kind: "other" as const };
    if (!isC2paMedia(probe)) return row("skipped", null, "other", "Not an image or PDF; text is covered by the signed page hash.");
    const res = s.d.assetProbe ? await s.d.assetProbe(m.asset_url).catch(() => null) : null;
    if (!res || res.status !== 200) return row("failed", null, mediaTypeOf(probe) ?? "other", `The asset could not be read (${res ? `it answered ${res.status}` : "no answer"}).`);
    if (res.truncated) return row("failed", null, mediaTypeOf(probe) ?? "other", "The asset is larger than Trooth reads for a credential.");
    entry = { url: m.asset_url, title: m.asset_url, kind: (res.headers["content-type"] ?? "").includes("pdf") ? "pdf" : "other", hash: `sha256:${await sha256Hex(res.body)}`, bytes: res.body.length, witnessed_at: iso(now) };
  }
  const kind = mediaTypeOf(entry) ?? "other";
  if (!isC2paMedia(entry)) return row("skipped", entry.hash.slice(7), kind, "Not an image or PDF; text is covered by the signed page hash.");
  const sha = entry.hash.slice(7);
  if (!HEX64.test(sha)) return row("failed", null, kind, "The asset's digest is not a sha256 digest.");
  const manifest = buildC2paManifest(entry, { publicApiBase: s.publicBase(), publisher: { name: company.org, url: `https://${company.domain}/` }, trooth_id: m.trooth_id, version_id: semantoId("smv", file.root_hash) });
  await s.store.putBlob(credentialKey(m.trooth_id, sha), new TextEncoder().encode(JSON.stringify({ object: "semanto.c2pa_manifest", sha256: sha, asset_url: m.asset_url, manifest, signing_note: SIGNING_NOTE })), CREDENTIAL_CONTENT_TYPE);
  return row("made", sha, kind, null);
}

/** GET /os/semanto/{id}/credentials?state=&cursor=. */
export async function listCredentials(s: OsService, trooth_id: string, q: Record<string, string>): Promise<WorkspaceResult> {
  if (q.state !== undefined && q.state !== "made" && q.state !== "failed" && q.state !== "skipped") return problem("invalid_request", "state is made, failed or skipped.");
  const offset = decodeCursor(q.cursor);
  if (offset === null) return problem("invalid_request", "cursor is not one this server gave. Start again without a cursor.");
  const limit = 50;
  const { rows, totals } = await s.store.credentials(trooth_id, { ...(q.state ? { state: q.state as CredentialState } : {}), offset, limit: limit + 1 });
  return ok(200, {
    object: "semanto.credentials",
    trooth_id,
    rows: rows.slice(0, limit).map((r) => ({ asset_url: r.asset_url, sha256: r.sha256, kind: r.kind, source: r.source, state: r.state, reason: r.reason, made_at: r.made_at, ...(r.state === "made" && r.sha256 ? { manifest_url: `${s.publicBase()}/${trooth_id}/credentials/${r.sha256}` } : {}) })),
    totals,
    next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null,
  });
}

/** GET /public/semanto/{id}/credentials/{sha256}: the stored manifest, or null. */
export async function publicCredential(s: OsService, trooth_id: string, sha: string): Promise<Uint8Array | null> {
  if (!HEX64.test(sha)) return null;
  const company = await s.company(trooth_id);
  if (!company || !isDomainProven(company)) return null;
  if (!(await s.store.credentialBySha(trooth_id, sha))) return null;
  return s.store.getBlob(credentialKey(trooth_id, sha));
}
