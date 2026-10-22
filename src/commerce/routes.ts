// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Pure handlers for the commerce routes. Each takes plain values and returns
// { status, headers, body }; src/serve turns that into a Response and adds
// the proof headers. Errors are RFC 9457 problem details. The feed kind is
// chosen by the path (merchant-center, acp, ucp), never by User-Agent.
//
//   GET /public/semanto/{trooth_id}/products
//   GET /public/semanto/{trooth_id}/products/{smk_id}
//   GET /public/semanto/{trooth_id}/offers
//   GET /public/semanto/{trooth_id}/offers/{sku}
//   GET /public/semanto/{trooth_id}/feeds/{merchant-center|acp|ucp}
//   GET /.well-known/ucp   (per company, through the adapters)

import type { CommerceStore } from "./ports";
import { offerFeed, offerAnswer } from "./offers";
import { generateFeeds, ucpManifest, FEED_KINDS, type FeedKind } from "./feeds";
import { withRecallStatus } from "./recalls";

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  retryable: boolean;
  next_action: string;
  terminal: boolean;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept" };

export function problem(status: number, code: string, title: string, detail: string, next_action: string, opts: { retryable?: boolean; terminal?: boolean } = {}): PlainResponse {
  const p: Problem = { type: `https://trooth.co/problems/${code}`, title, status, detail, code, retryable: opts.retryable ?? false, next_action, terminal: opts.terminal ?? true };
  return { status, headers: { "Content-Type": "application/problem+json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(p) };
}

export function problemMarkdown(p: PlainResponse): PlainResponse {
  const j = JSON.parse(p.body) as Problem;
  const md = `# ${j.title}\n\n${j.detail}\n\nWhat to do next: ${j.next_action}\n\nCode: ${j.code}\n`;
  return { status: p.status, headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" }, body: md };
}

const json = (status: number, value: unknown, extra: Record<string, string> = {}): PlainResponse => ({ status, headers: Object.assign({}, JSON_HEADERS, extra), body: JSON.stringify(value) });

export async function productsResponse(store: CommerceStore, trooth_id: string, now: Date): Promise<PlainResponse> {
  const company = await store.company(trooth_id);
  if (!company) return problem(404, "company_not_found", "No such company", `No Semanto record is served for ${trooth_id}.`, "Check the Trooth id.");
  const records = await store.records(trooth_id);
  return json(200, {
    object: "semanto.product_list",
    trooth_id,
    generated_at: now.toISOString(),
    products: records.map((r) => ({ id: r.record.id, sku: r.record.sku, variant_id: r.record.variant_id ?? null, gtin: r.record.gtin ?? null, name: r.record.name, url: `${company.public_base.replace(/\/$/, "")}/products/${r.record.id}`, record: r.record, jws: r.jws })),
  });
}

export async function productResponse(store: CommerceStore, trooth_id: string, record_id: string): Promise<PlainResponse> {
  const signed = await store.record(trooth_id, record_id);
  if (!signed) return problem(404, "product_not_found", "No such product record", `No product record ${record_id} is served for ${trooth_id}.`, "List /products for the ids this company serves.");
  return json(200, { object: "semanto.product_envelope", record: signed.record, jws: signed.jws, kid: signed.kid }, { ETag: `"${signed.record.id}"` });
}

export async function offersResponse(store: CommerceStore, trooth_id: string, now: Date): Promise<PlainResponse> {
  const company = await store.company(trooth_id);
  if (!company) return problem(404, "company_not_found", "No such company", `No Semanto record is served for ${trooth_id}.`, "Check the Trooth id.");
  const policy = await store.offerPolicy(trooth_id);
  const signed = await store.offers(trooth_id);
  const recalls = (await store.recalls(trooth_id)).map((r) => r.notice);
  const feed = offerFeed({ domain: company.domain, trooth_id }, signed, now, policy);
  const offers = feed.offers.map((e) => Object.assign({}, e, { availability_answer: withRecallStatus(e.offer, recalls, { now }).availability_answer }));
  return json(200, Object.assign({}, feed, { offers }));
}

export async function offerResponse(store: CommerceStore, trooth_id: string, sku: string, now: Date): Promise<PlainResponse> {
  const policy = await store.offerPolicy(trooth_id);
  const signed = await store.offers(trooth_id, sku);
  const answer = offerAnswer(sku, signed, now, policy);
  if (!answer.found) return problem(404, "offer_not_found", "No offer for this sku", `${trooth_id} serves no signed offer for sku ${sku}.`, "Ask /products for the skus this company sells.");
  const recalls = (await store.recalls(trooth_id)).map((r) => r.notice);
  const records = await store.records(trooth_id);
  const gtin = records.find((r) => r.record.sku === sku)?.record.gtin;
  const overlay = withRecallStatus(answer.offer, recalls, { now, gtin });
  return json(200, Object.assign({}, answer, { availability_answer: overlay.availability_answer, recalled: overlay.recalled, recall_ids: overlay.recall_ids, recall_urls: overlay.recall_urls }), { "Cache-Control": `max-age=${Math.max(0, Math.floor((Date.parse(answer.not_after) - now.getTime()) / 1000))}` });
}

export async function feedResponse(store: CommerceStore, trooth_id: string, kind: string, now: Date, format: "tsv" | "json" = "json"): Promise<PlainResponse> {
  if (!(FEED_KINDS as readonly string[]).includes(kind)) return problem(404, "feed_kind_unknown", "No such feed", `Feeds are ${FEED_KINDS.join(", ")}.`, "Use one of those names in the path.");
  const company = await store.company(trooth_id);
  if (!company) return problem(404, "company_not_found", "No such company", `No Semanto record is served for ${trooth_id}.`, "Check the Trooth id.");
  const records = (await store.records(trooth_id)).map((r) => r.record);
  const offers = (await store.offers(trooth_id)).map((o) => o.offer);
  const feeds = await generateFeeds({ company, records, offers }, now);
  const k = kind as FeedKind;
  if (k === "merchant-center") {
    if (format === "tsv") return { status: 200, headers: { "Content-Type": "text/tab-separated-values; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept" }, body: feeds.merchant_center.tsv };
    return json(200, feeds.merchant_center.json);
  }
  if (k === "acp") return json(200, feeds.acp);
  return json(200, feeds.ucp.catalog);
}

export async function ucpManifestResponse(store: CommerceStore, trooth_id: string): Promise<PlainResponse> {
  const company = await store.company(trooth_id);
  if (!company) return problem(404, "company_not_found", "No such company", `No Semanto record is served for ${trooth_id}.`, "Check the Trooth id.");
  return json(200, ucpManifest(company), { "Cache-Control": "max-age=3600" });
}
