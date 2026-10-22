// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The C2PA bridge: map a Semanto manifest to C2PA assertions for the images
// and PDFs in a site's documents tier. Output is the c2pa-rs manifest
// definition JSON (the shape `c2patool` and the c2pa SDKs take as input):
// claim_generator_info, title, format, and an assertions list with
// c2pa.actions (action c2pa.published), stds.schema-org.CreativeWork (the
// publisher Organization and Trooth as a contributor in the role of witness),
// a c2pa.hash.data placeholder the signing tool fills, and a custom assertion
// "co.trooth.semanto" that binds the media item to the Semanto version, page
// id, page hash and proof URL. Follows C2PA Technical Specification 2.2
// (assertion labels, action names) and the c2pa-rs ManifestDefinition
// (github.com/contentauth/c2pa-rs, docs/manifest/manifest-ref.md).
//
// This module builds JSON only. Signing a C2PA manifest and embedding it in
// the asset needs the c2pa tooling (c2patool or the c2pa-rs or c2pa-node SDK)
// and a signing certificate the founder installs; neither is in this Worker.
//
// Text: C2PA 2.4 Annex A.8 (content binding for text) is under review and is
// NOT used here for pages. Text stays covered by the signed Semanto record and
// its page hashes. textAnnexStatus() returns the exact status string for the
// dashboard so the wording is the same everywhere.

import { semantoId } from "../core/ids";
import type { DocumentEntry, SemantoFile } from "../core/semanto";

export const CLAIM_GENERATOR = { name: "Trooth Semanto", version: "0.1.0" } as const;
export const CLAIM_GENERATOR_STRING = `${CLAIM_GENERATOR.name}/${CLAIM_GENERATOR.version}`;
export const TROOTH_ASSERTION_LABEL = "co.trooth.semanto" as const;
export const HASH_PLACEHOLDER = "to be computed by the c2pa signing tool over the asset bytes";

export const TEXT_ANNEX_STATUS = "C2PA 2.4 Annex A.8 (text) is under review and is not used for text. Pages are covered by the signed Semanto record and its page hashes." as const;

/** The exact status string the dashboard shows for text. */
export function textAnnexStatus(): typeof TEXT_ANNEX_STATUS {
  return TEXT_ANNEX_STATUS;
}

export interface TroothSemantoAssertion {
  trooth_id: string;
  /** smv_ id of the Semanto version the item is in. */
  version_id: string;
  /** smp_ id derived from the item's digest. */
  page_id: string;
  /** Digest of the item's bytes as witnessed. */
  page_hash: string;
  /** Where the inclusion proof for the item is served. */
  proof_url: string;
  /** The address the item was witnessed at, and when. */
  url: string;
  witnessed_at: string;
}

export interface C2paAssertion<T = unknown> {
  label: string;
  data: T;
}

export interface C2paManifestDefinition {
  claim_generator: string;
  claim_generator_info: { name: string; version: string }[];
  title: string;
  format: string;
  instance_id: string;
  assertions: C2paAssertion[];
}

export interface BridgeContext {
  /** For example https://api.trooth.co/public/semanto. */
  publicApiBase: string;
  /** The organization that published the site, from the Semanto header. */
  publisher: { name: string; url: string };
  trooth_id: string;
  version_id: string;
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export function mediaTypeOf(entry: Pick<DocumentEntry, "url" | "kind">): string | null {
  if (entry.kind === "pdf") return MEDIA_TYPES.pdf!;
  let path: string;
  try {
    path = new URL(entry.url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const ext = path.split(".").pop() ?? "";
  return MEDIA_TYPES[ext] ?? null;
}

/** Only images, PDFs, video and audio are C2PA media; HTML pages and other text are not. */
export function isC2paMedia(entry: Pick<DocumentEntry, "url" | "kind">): boolean {
  return mediaTypeOf(entry) !== null;
}

export function buildC2paManifest(entry: DocumentEntry, ctx: BridgeContext): C2paManifestDefinition {
  const format = mediaTypeOf(entry);
  if (!format) throw new Error(`buildC2paManifest: ${entry.url} is not a C2PA media type`);
  const page_id = semantoId("smp", entry.hash);
  const proof_url = `${ctx.publicApiBase.replace(/\/$/, "")}/${ctx.trooth_id}/pages/${page_id}/proof`;
  const trooth: TroothSemantoAssertion = {
    trooth_id: ctx.trooth_id,
    version_id: ctx.version_id,
    page_id,
    page_hash: entry.hash,
    proof_url,
    url: entry.url,
    witnessed_at: entry.witnessed_at,
  };
  return {
    claim_generator: CLAIM_GENERATOR_STRING,
    claim_generator_info: [{ name: CLAIM_GENERATOR.name, version: CLAIM_GENERATOR.version }],
    title: entry.title || entry.url,
    format,
    instance_id: `xmp:iid:${page_id}`,
    assertions: [
      {
        label: "c2pa.actions",
        data: {
          actions: [
            {
              action: "c2pa.published",
              when: entry.witnessed_at,
              softwareAgent: { name: CLAIM_GENERATOR.name, version: CLAIM_GENERATOR.version },
              parameters: { url: entry.url },
            },
          ],
        },
      },
      {
        label: "stds.schema-org.CreativeWork",
        data: {
          "@context": "https://schema.org",
          "@type": "CreativeWork",
          url: entry.url,
          name: entry.title || entry.url,
          datePublished: entry.witnessed_at,
          publisher: { "@type": "Organization", name: ctx.publisher.name, url: ctx.publisher.url },
          contributor: [{ "@type": "Organization", name: "Trooth", url: "https://trooth.co", roleName: "witness" }],
        },
      },
      {
        label: "c2pa.hash.data",
        data: { exclusions: [], name: "jumbf manifest", alg: "sha256", hash: HASH_PLACEHOLDER, pad: "" },
      },
      { label: TROOTH_ASSERTION_LABEL, data: trooth },
    ],
  };
}

export interface BridgeOutput {
  manifests: { url: string; manifest: C2paManifestDefinition }[];
  /** Documents left out because they are not C2PA media (text, html, unknown types). */
  skipped: { url: string; reason: string }[];
  text_status: typeof TEXT_ANNEX_STATUS;
  signing_note: string;
}

export const SIGNING_NOTE = "These are c2pa-rs manifest definitions. To sign and embed them, run c2patool or the c2pa SDK with the signing certificate installed outside this Worker.";

/** One manifest per media item in the documents tier. */
export function buildC2paManifests(file: SemantoFile, publicApiBase: string): BridgeOutput {
  const h = file.header;
  const ctx: BridgeContext = {
    publicApiBase,
    publisher: { name: h.org, url: `https://${h.identity.domain}/` },
    trooth_id: h.trooth_id,
    version_id: semantoId("smv", file.root_hash),
  };
  const manifests: BridgeOutput["manifests"] = [];
  const skipped: BridgeOutput["skipped"] = [];
  for (const d of file.documents) {
    if (!isC2paMedia(d)) {
      skipped.push({ url: d.url, reason: "not a C2PA media type; text is covered by the Semanto page hash" });
      continue;
    }
    manifests.push({ url: d.url, manifest: buildC2paManifest(d, ctx) });
  }
  return { manifests, skipped, text_status: TEXT_ANNEX_STATUS, signing_note: SIGNING_NOTE };
}

/** The `c2patool` invocation for one manifest, for the founder's runbook. */
export function c2patoolCommand(assetPath: string, manifestPath: string, outputPath: string): string {
  return `c2patool "${assetPath}" --manifest "${manifestPath}" --output "${outputPath}"`;
}
