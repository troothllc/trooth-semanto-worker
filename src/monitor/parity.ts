// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The parity check: does each signed fact still appear, word for word, in the
// visible text of the page it was read from? Deterministic and explainable:
// the same signed record and the same live page always give the same answer,
// with no model in the loop. A fact counts only when its page answered 200;
// a page that did not is "not read", never a mismatch. Text hidden from people
// (the hidden attribute, aria-hidden, display:none, visibility:hidden) is not
// part of the page for this check (src/monitor/html.ts visibleText).
//
//   "Facts that match your pages: 41 of 44."

import type { Fact } from "../core/semanto";
import type { LivePageRead } from "./types";

export interface ParityResult {
  /** Facts whose page was read and whose value is text or a number. */
  compared: number;
  matches: number;
  /** The facts whose value is not in their page's visible text, with where to look. */
  differs: { fact_id: string; key: string; value: string; url: string }[];
  /** Facts whose page did not answer 200 this run. */
  not_read: number;
  sentence: string;
}

/** Lowercase, compatibility-folded, curly quotes and dashes made plain, whitespace collapsed. */
export function parityText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function valuesOf(f: Fact): string[] | null {
  const v = f.value;
  if (typeof v === "string") return v.trim().length >= 2 ? [v] : null;
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return v as string[];
  return null;
}

/** True when the value is in the text; a value of seven or more digits (a phone number) also matches on its digits alone. */
export function appearsIn(value: string, text: string, digits: string): boolean {
  const v = parityText(value);
  if (text.includes(v)) return true;
  const d = value.replace(/\D/g, "");
  return d.length >= 7 && d.length === value.replace(/[\s().+\-]/g, "").length && digits.includes(d);
}

export function parity(facts: Fact[], pages: Map<string, LivePageRead | null>): ParityResult {
  let compared = 0;
  let notRead = 0;
  const differs: ParityResult["differs"] = [];
  const texts = new Map<string, { text: string; digits: string }>();
  for (const f of facts) {
    const values = valuesOf(f);
    if (!values) continue;
    const page = pages.get(f.evidence.url);
    if (!page || page.status !== 200) {
      notRead++;
      continue;
    }
    let t = texts.get(f.evidence.url);
    if (!t) {
      const text = parityText(page.text);
      t = { text, digits: text.replace(/\D/g, "") };
      texts.set(f.evidence.url, t);
    }
    compared++;
    const missing = values.find((v) => !appearsIn(v, t!.text, t!.digits));
    if (missing !== undefined) differs.push({ fact_id: f.id, key: f.key, value: missing, url: f.evidence.url });
  }
  const matches = compared - differs.length;
  const sentence = `Facts that match your pages: ${matches} of ${compared}.${notRead ? ` ${notRead === 1 ? "1 fact's page was" : `${notRead} facts' pages were`} not read this time.` : ""}`;
  return { compared, matches, differs, not_read: notRead, sentence };
}
