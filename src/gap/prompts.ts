// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The buyer question sets for the gap report: what a buyer asks an AI
// assistant about a company before buying, parameterized by company name,
// domain and product names. Each question maps to the dotted fact keys in the
// signed record that answer it, so an answer can be compared line by line.
//
// Four sets: B2B (security and terms), shopping (a named product), local (a
// place people visit) and competitor framing ("Which of A and B"). The shape
// follows the buyer-prompt practice of the AI visibility tools of 2025 and
// 2026 (Profound, Peec AI, Semrush AI Toolkit), with one difference: every
// question here is tied to a fact key, so the comparison is against a signed
// statement, not against a general impression.

export type QuestionKind = "b2b" | "shopping" | "local" | "competitor";

/** How a fact under a key is read out of an answer, and the words that mark the topic in a sentence. */
export type KeyType = "money" | "boolean" | "hours" | "phone" | "address" | "percent" | "days" | "named" | "list" | "text";

export interface KeyInfo {
  type: KeyType;
  /** Words that mark a sentence as being about this key (case-insensitive). */
  terms: string[];
}

export interface QuestionParams {
  company: string;
  domain: string;
  /** Product names; the shopping set is instantiated once per product. */
  products: string[];
  /** The other company for the competitor set. */
  competitor?: { name: string; domain: string };
  /** A named service for the local set (for example "an oil change"). */
  service?: string;
}

/** A question template. `{slug}` in a key is replaced with the product slug. */
export interface QuestionTemplate {
  id: string;
  kind: QuestionKind;
  keys: string[];
  text: (p: QuestionParams, product?: string) => string;
}

/** An instantiated question, ready to send to a provider. */
export interface Question {
  id: string;
  template_id: string;
  kind: QuestionKind;
  text: string;
  keys: string[];
  /** The product this question is about, when it is about one. */
  product?: string;
}

export function productSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ------------------------------------------------------------------ key catalog

/** Every key the question sets reach, with how its value is read and the words that mark it. */
export const KEY_CATALOG: Record<string, KeyInfo> = {
  "security.mfa": { type: "boolean", terms: ["multi-factor", "multifactor", "two-factor", "2FA", "MFA"] },
  "security.mfa_methods": { type: "list", terms: ["authenticator", "TOTP", "passkey", "SMS", "security key", "WebAuthn", "FIDO"] },
  "security.encryption_at_rest": { type: "boolean", terms: ["encrypted at rest", "encryption at rest", "at rest"] },
  "security.encryption_in_transit": { type: "boolean", terms: ["in transit", "TLS"] },
  "security.soc2": { type: "boolean", terms: ["SOC 2", "SOC2", "SOC-2"] },
  "security.iso27001": { type: "boolean", terms: ["ISO 27001", "ISO/IEC 27001", "ISO27001"] },
  "security.data_residency": { type: "list", terms: ["data residency", "stored in", "hosted in", "data center", "region"] },
  "security.page_url": { type: "text", terms: ["security page", "trust center", "trust page"] },
  "privacy.subprocessors": { type: "list", terms: ["subprocessor", "sub-processor"] },
  "privacy.data_deletion_days": { type: "days", terms: ["delet", "purge", "retention"] },
  "terms.uptime_commitment": { type: "percent", terms: ["uptime", "availability", "SLA"] },
  "terms.sla_credits": { type: "boolean", terms: ["service credit", "SLA credit", "credits"] },
  "terms.minimum_term": { type: "named", terms: ["minimum term", "contract term", "commitment", "annual contract", "month-to-month"] },
  "terms.cancellation_notice": { type: "named", terms: ["cancel", "notice"] },
  "support.hours": { type: "hours", terms: ["support hours", "support is available", "support team", "support"] },
  "support.channels": { type: "list", terms: ["email", "chat", "phone", "ticket", "portal"] },
  "commercial.pricing_model": { type: "named", terms: ["per seat", "per user", "usage-based", "flat", "tiered", "pricing model", "priced"] },
  "commercial.starting_price": { type: "money", terms: ["starts at", "starting at", "from", "per month", "per user", "per seat"] },
  "commercial.free_trial": { type: "boolean", terms: ["free trial", "trial"] },
  "commercial.returns_window_days": { type: "days", terms: ["return", "refund"] },
  "commercial.authorized_sellers": { type: "list", terms: ["buy", "sold", "retailer", "available at", "stockist"] },
  "commercial.shipping_free_over": { type: "money", terms: ["free shipping", "shipping"] },
  "commercial.ships_international": { type: "boolean", terms: ["international", "worldwide", "outside the"] },
  "products.{slug}.price": { type: "money", terms: ["price", "cost", "costs", "priced", "retails"] },
  "products.{slug}.sale_price": { type: "money", terms: ["sale", "discount", "off", "deal"] },
  "products.{slug}.availability": { type: "named", terms: ["in stock", "out of stock", "available", "sold out", "backorder", "pre-order", "preorder"] },
  "products.{slug}.sizes": { type: "list", terms: ["size", "sizes"] },
  "products.{slug}.variants": { type: "list", terms: ["color", "colour", "variant", "option", "finish"] },
  "products.{slug}.variant_differences": { type: "text", terms: ["difference", "differs", "compared", "versus", "vs"] },
  "products.{slug}.materials": { type: "list", terms: ["made of", "made from", "material", "ingredient", "contains"] },
  "products.{slug}.warranty": { type: "named", terms: ["warranty", "guarantee"] },
  "products.{slug}.safety_warnings": { type: "text", terms: ["warning", "caution", "not suitable", "choking", "hazard"] },
  "products.{slug}.safety_standards": { type: "list", terms: ["standard", "tested to", "complies", "compliant", "EN ", "ASTM", "CPSC", "UL "] },
  "products.{slug}.dimensions": { type: "text", terms: ["weigh", "weight", "dimension", "measures", "cm", "inches", "kg", "lb"] },
  "local.hours": { type: "hours", terms: ["open", "hours", "opening"] },
  "local.hours_sunday": { type: "hours", terms: ["sunday"] },
  "local.holiday_hours": { type: "text", terms: ["holiday", "christmas", "thanksgiving", "closed on"] },
  "local.address": { type: "address", terms: ["located", "address", "find us", "at "] },
  "local.phone": { type: "phone", terms: ["phone", "call", "telephone", "reach"] },
  "local.email": { type: "text", terms: ["email", "e-mail", "@"] },
  "local.services": { type: "list", terms: ["service", "offer", "provide"] },
  "local.service_price": { type: "money", terms: ["cost", "price", "charge", "fee"] },
  "local.parking": { type: "named", terms: ["parking", "park", "garage", "lot"] },
  "local.accessibility": { type: "boolean", terms: ["wheelchair", "accessible", "step-free", "ramp", "elevator"] },
  "local.appointment_policy": { type: "named", terms: ["appointment", "book", "reservation"] },
  "local.walk_ins": { type: "boolean", terms: ["walk-in", "walk in", "walk-ins", "without an appointment"] },
  "local.payment_methods": { type: "list", terms: ["accept", "payment", "cash", "card", "Apple Pay", "Google Pay"] },
  "local.delivery": { type: "boolean", terms: ["deliver", "delivery", "pickup", "pick-up", "curbside"] },
  "local.languages": { type: "list", terms: ["language", "speak", "spoken", "Spanish", "French", "Mandarin"] },
};

export function keyInfo(key: string): KeyInfo {
  const generic = key.replace(/^products\.[^.]+\./, "products.{slug}.");
  return KEY_CATALOG[generic] ?? { type: "text", terms: [key.split(".").pop() ?? key] };
}

// ------------------------------------------------------------------ templates

const c = (p: QuestionParams) => p.company;
const other = (p: QuestionParams) => p.competitor?.name ?? "its closest competitor";

export const B2B_QUESTIONS: QuestionTemplate[] = [
  { id: "b2b.mfa", kind: "b2b", keys: ["security.mfa", "security.mfa_methods"], text: (p) => `Does ${c(p)} support multi-factor authentication, and which methods?` },
  { id: "b2b.encryption_at_rest", kind: "b2b", keys: ["security.encryption_at_rest"], text: (p) => `Is customer data at ${c(p)} encrypted at rest?` },
  { id: "b2b.encryption_in_transit", kind: "b2b", keys: ["security.encryption_in_transit"], text: (p) => `Does ${c(p)} encrypt data in transit?` },
  { id: "b2b.soc2", kind: "b2b", keys: ["security.soc2"], text: (p) => `Does ${c(p)} have a SOC 2 report?` },
  { id: "b2b.iso27001", kind: "b2b", keys: ["security.iso27001"], text: (p) => `Does ${c(p)} hold ISO 27001?` },
  { id: "b2b.data_residency", kind: "b2b", keys: ["security.data_residency"], text: (p) => `Where does ${c(p)} store customer data? Which regions can I choose?` },
  { id: "b2b.subprocessors", kind: "b2b", keys: ["privacy.subprocessors"], text: (p) => `Which subprocessors does ${c(p)} use?` },
  { id: "b2b.uptime", kind: "b2b", keys: ["terms.uptime_commitment"], text: (p) => `What uptime does ${c(p)} commit to?` },
  { id: "b2b.sla_credits", kind: "b2b", keys: ["terms.sla_credits"], text: (p) => `Does ${c(p)} give service credits when it misses its uptime commitment?` },
  { id: "b2b.support_hours", kind: "b2b", keys: ["support.hours"], text: (p) => `What are ${c(p)}'s support hours?` },
  { id: "b2b.support_channels", kind: "b2b", keys: ["support.channels"], text: (p) => `How can I contact ${c(p)} support?` },
  { id: "b2b.pricing_model", kind: "b2b", keys: ["commercial.pricing_model"], text: (p) => `How does ${c(p)} charge: per seat, usage-based or flat?` },
  { id: "b2b.starting_price", kind: "b2b", keys: ["commercial.starting_price"], text: (p) => `What does ${c(p)} cost to start?` },
  { id: "b2b.free_trial", kind: "b2b", keys: ["commercial.free_trial"], text: (p) => `Does ${c(p)} offer a free trial?` },
  { id: "b2b.minimum_term", kind: "b2b", keys: ["terms.minimum_term"], text: (p) => `What is the minimum contract term at ${c(p)}?` },
  { id: "b2b.cancellation", kind: "b2b", keys: ["terms.cancellation_notice"], text: (p) => `How much notice does ${c(p)} need to cancel?` },
  { id: "b2b.data_deletion", kind: "b2b", keys: ["privacy.data_deletion_days"], text: (p) => `How long after I leave does ${c(p)} delete my data?` },
  { id: "b2b.security_page", kind: "b2b", keys: ["security.page_url"], text: (p) => `Where does ${c(p)} publish its security information?` },
];

export const SHOPPING_QUESTIONS: QuestionTemplate[] = [
  { id: "shop.price", kind: "shopping", keys: ["products.{slug}.price"], text: (p, pr) => `How much does the ${pr} from ${c(p)} cost?` },
  { id: "shop.sale_price", kind: "shopping", keys: ["products.{slug}.sale_price"], text: (p, pr) => `Is the ${c(p)} ${pr} on sale right now?` },
  { id: "shop.availability", kind: "shopping", keys: ["products.{slug}.availability"], text: (p, pr) => `Is the ${c(p)} ${pr} in stock?` },
  { id: "shop.sizes", kind: "shopping", keys: ["products.{slug}.sizes"], text: (p, pr) => `What sizes does the ${c(p)} ${pr} come in?` },
  { id: "shop.variants", kind: "shopping", keys: ["products.{slug}.variants"], text: (p, pr) => `What colors or versions of the ${c(p)} ${pr} are there?` },
  { id: "shop.variant_differences", kind: "shopping", keys: ["products.{slug}.variant_differences"], text: (p, pr) => `What is the difference between the versions of the ${c(p)} ${pr}?` },
  { id: "shop.materials", kind: "shopping", keys: ["products.{slug}.materials"], text: (p, pr) => `What is the ${c(p)} ${pr} made of?` },
  { id: "shop.warranty", kind: "shopping", keys: ["products.{slug}.warranty"], text: (p, pr) => `What warranty comes with the ${c(p)} ${pr}?` },
  { id: "shop.returns", kind: "shopping", keys: ["commercial.returns_window_days"], text: (p, pr) => `Can I return the ${c(p)} ${pr}, and within how many days?` },
  { id: "shop.where_to_buy", kind: "shopping", keys: ["commercial.authorized_sellers"], text: (p, pr) => `Where can I buy the ${c(p)} ${pr}?` },
  { id: "shop.safety_warnings", kind: "shopping", keys: ["products.{slug}.safety_warnings"], text: (p, pr) => `Are there safety warnings for the ${c(p)} ${pr}?` },
  { id: "shop.safety_standards", kind: "shopping", keys: ["products.{slug}.safety_standards"], text: (p, pr) => `Which safety standards is the ${c(p)} ${pr} tested to?` },
  { id: "shop.dimensions", kind: "shopping", keys: ["products.{slug}.dimensions"], text: (p, pr) => `How big is the ${c(p)} ${pr} and how much does it weigh?` },
  { id: "shop.shipping", kind: "shopping", keys: ["commercial.shipping_free_over"], text: (p) => `Does ${c(p)} offer free shipping, and from what order size?` },
  { id: "shop.international", kind: "shopping", keys: ["commercial.ships_international"], text: (p) => `Does ${c(p)} ship internationally?` },
];

export const LOCAL_QUESTIONS: QuestionTemplate[] = [
  { id: "local.hours", kind: "local", keys: ["local.hours"], text: (p) => `What are ${c(p)}'s opening hours?` },
  { id: "local.sunday", kind: "local", keys: ["local.hours_sunday"], text: (p) => `Is ${c(p)} open on Sunday?` },
  { id: "local.holiday", kind: "local", keys: ["local.holiday_hours"], text: (p) => `Is ${c(p)} open on public holidays?` },
  { id: "local.address", kind: "local", keys: ["local.address"], text: (p) => `What is the address of ${c(p)}?` },
  { id: "local.phone", kind: "local", keys: ["local.phone"], text: (p) => `What is the phone number for ${c(p)}?` },
  { id: "local.email", kind: "local", keys: ["local.email"], text: (p) => `What is the email address for ${c(p)}?` },
  { id: "local.services", kind: "local", keys: ["local.services"], text: (p) => `What services does ${c(p)} offer?` },
  { id: "local.service_price", kind: "local", keys: ["local.service_price"], text: (p) => `How much does ${p.service ?? "the main service"} cost at ${c(p)}?` },
  { id: "local.parking", kind: "local", keys: ["local.parking"], text: (p) => `Is there parking at ${c(p)}?` },
  { id: "local.accessibility", kind: "local", keys: ["local.accessibility"], text: (p) => `Is ${c(p)} wheelchair accessible?` },
  { id: "local.appointment", kind: "local", keys: ["local.appointment_policy"], text: (p) => `Do I need an appointment at ${c(p)}?` },
  { id: "local.walk_ins", kind: "local", keys: ["local.walk_ins"], text: (p) => `Does ${c(p)} take walk-ins?` },
  { id: "local.payment", kind: "local", keys: ["local.payment_methods"], text: (p) => `What payment methods does ${c(p)} accept?` },
  { id: "local.delivery", kind: "local", keys: ["local.delivery"], text: (p) => `Does ${c(p)} deliver or offer pickup?` },
  { id: "local.languages", kind: "local", keys: ["local.languages"], text: (p) => `What languages are spoken at ${c(p)}?` },
];

export const COMPETITOR_QUESTIONS: QuestionTemplate[] = [
  { id: "cmp.mfa", kind: "competitor", keys: ["security.mfa"], text: (p) => `Which of ${c(p)} and ${other(p)} supports multi-factor authentication?` },
  { id: "cmp.encryption_at_rest", kind: "competitor", keys: ["security.encryption_at_rest"], text: (p) => `Which of ${c(p)} and ${other(p)} encrypts data at rest?` },
  { id: "cmp.soc2", kind: "competitor", keys: ["security.soc2"], text: (p) => `Which of ${c(p)} and ${other(p)} has a SOC 2 report?` },
  { id: "cmp.data_residency", kind: "competitor", keys: ["security.data_residency"], text: (p) => `Which of ${c(p)} and ${other(p)} lets me choose where my data is stored?` },
  { id: "cmp.uptime", kind: "competitor", keys: ["terms.uptime_commitment"], text: (p) => `Which of ${c(p)} and ${other(p)} commits to higher uptime?` },
  { id: "cmp.starting_price", kind: "competitor", keys: ["commercial.starting_price"], text: (p) => `Which of ${c(p)} and ${other(p)} is cheaper to start with?` },
  { id: "cmp.free_trial", kind: "competitor", keys: ["commercial.free_trial"], text: (p) => `Which of ${c(p)} and ${other(p)} offers a free trial?` },
  { id: "cmp.support_hours", kind: "competitor", keys: ["support.hours"], text: (p) => `Which of ${c(p)} and ${other(p)} has longer support hours?` },
  { id: "cmp.cancellation", kind: "competitor", keys: ["terms.cancellation_notice"], text: (p) => `Which of ${c(p)} and ${other(p)} is easier to cancel?` },
  { id: "cmp.returns", kind: "competitor", keys: ["commercial.returns_window_days"], text: (p) => `Which of ${c(p)} and ${other(p)} has the longer return window?` },
  { id: "cmp.product_price", kind: "competitor", keys: ["products.{slug}.price"], text: (p, pr) => `Which of ${c(p)} and ${other(p)} sells the ${pr ?? "comparable product"} for less?` },
  { id: "cmp.warranty", kind: "competitor", keys: ["products.{slug}.warranty"], text: (p, pr) => `Which of ${c(p)} and ${other(p)} gives a longer warranty on the ${pr ?? "comparable product"}?` },
  { id: "cmp.international", kind: "competitor", keys: ["commercial.ships_international"], text: (p) => `Which of ${c(p)} and ${other(p)} ships internationally?` },
  { id: "cmp.hours", kind: "competitor", keys: ["local.hours"], text: (p) => `Which of ${c(p)} and ${other(p)} opens earlier?` },
  { id: "cmp.walk_ins", kind: "competitor", keys: ["local.walk_ins"], text: (p) => `Which of ${c(p)} and ${other(p)} takes walk-ins?` },
  { id: "cmp.parking", kind: "competitor", keys: ["local.parking"], text: (p) => `Which of ${c(p)} and ${other(p)} has easier parking?` },
];

export const QUESTION_SETS: Record<QuestionKind, QuestionTemplate[]> = {
  b2b: B2B_QUESTIONS,
  shopping: SHOPPING_QUESTIONS,
  local: LOCAL_QUESTIONS,
  competitor: COMPETITOR_QUESTIONS,
};

/** Instantiate a set for a company. Product questions repeat once per product. */
export function questionsFor(kind: QuestionKind, p: QuestionParams): Question[] {
  const out: Question[] = [];
  const products = p.products.length ? p.products : [];
  for (const t of QUESTION_SETS[kind]) {
    const perProduct = t.keys.some((k) => k.includes("{slug}"));
    if (perProduct) {
      for (const pr of products) {
        const slug = productSlug(pr);
        out.push({
          id: `${t.id}:${slug}`,
          template_id: t.id,
          kind,
          text: t.text(p, pr),
          keys: t.keys.map((k) => k.replace("{slug}", slug)),
          product: pr,
        });
      }
    } else {
      out.push({ id: t.id, template_id: t.id, kind, text: t.text(p), keys: [...t.keys] });
    }
  }
  return out;
}

/** All four sets for one company. */
export function allQuestions(p: QuestionParams): Question[] {
  return (["b2b", "shopping", "local", "competitor"] as QuestionKind[]).flatMap((k) => questionsFor(k, p));
}

/** Every key any template can reach, with product keys in generic form. */
export function coveredKeys(): string[] {
  const keys = new Set<string>();
  for (const set of Object.values(QUESTION_SETS)) for (const t of set) for (const k of t.keys) keys.add(k);
  return [...keys].sort();
}
