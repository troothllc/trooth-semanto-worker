// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// DeliverySettingsPanel: the settings table for how a company's Semanto is
// served. The data shape is src/settings/delivery.ts DeliverySettings, so the
// panel is a drop-in for what POST /os/semanto/{id}/settings accepts. Plain
// data in, callbacks out; the parent fetches and saves (the pattern
// semanto-record-panel.tsx and Vercel's project settings pages use: one
// table, one row per setting, the consequence of each choice written next to
// it). Blue appears on the one save action only.

"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { fmtDateTime } from "./format";

export type HostKind = "cloudflare" | "vercel" | "netlify" | "fastly" | "akamai" | "gcore" | "nginx" | "apache" | "wordpress" | "head_tag" | "unknown";
export type MarkdownSource = "semanto_only" | "semanto_then_cloudflare_for_unsigned" | "cloudflare_format_semanto_proof_only";
export type WhenPageChanged = "serve_last_signed_marked_behind" | "serve_live_marked_unsigned" | "prompt_to_sign";

/** Mirrors src/settings/delivery.ts DeliverySettings. */
export interface DeliverySettingsData {
  where: { trooth_hosted: true; own_domain: boolean };
  host: HostKind;
  formats: { markdown: boolean; jsonld: boolean; llms: boolean; sitemap_md: boolean; whole_file: true };
  markdown_source: MarkdownSource;
  when_page_changed: WhenPageChanged;
  content_signals: { "ai-train": boolean; search: boolean; "ai-input": boolean };
}

/** What Trooth found about the host the last time it looked (src/serve/detect.ts). */
export interface HostDetection {
  detected: HostKind;
  cloudflare_markdown: boolean;
  well_known_served: boolean;
  dns_pointer: boolean;
  checked_at: string | null;
}

export interface DeliverySettingsPanelProps {
  settings: DeliverySettingsData;
  detection: HostDetection | null;
  /** The company's trooth id and domain, for the "where" row. */
  trooth_id: string;
  domain: string;
  /** Called with the whole changed settings object. The parent keeps the draft and saves it. */
  onChange: (next: DeliverySettingsData) => void;
  onSave: () => void;
  saving?: boolean;
  /** True when the draft differs from what is saved. */
  dirty?: boolean;
  /** Validation messages from the server, by path, after a failed save. */
  issues?: { path: string; message: string }[];
}

export const HOST_TEXT: Record<HostKind, string> = {
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  fastly: "Fastly",
  akamai: "Akamai",
  gcore: "Gcore",
  nginx: "nginx",
  apache: "Apache",
  wordpress: "WordPress",
  head_tag: "A head tag only (no code can run on the host)",
  unknown: "Not known yet",
};

const MARKDOWN_MODE_TEXT: Record<MarkdownSource, { label: string; body: string }> = {
  semanto_only: { label: "Semanto's markdown only", body: "Every markdown and JSON-LD request is answered with the signed bytes. A page that is not in the signed file gets a not-found notice in markdown." },
  semanto_then_cloudflare_for_unsigned: { label: "Semanto first, Cloudflare for the rest", body: "Signed pages are answered by Semanto, so the host's converter never touches them. Pages that are not signed fall through to Cloudflare's converter and carry no proof." },
  cloudflare_format_semanto_proof_only: { label: "Cloudflare's markdown, Semanto's proofs only", body: "Cloudflare's converter answers every markdown request. Semanto serves the signed file, the facts, llms.txt and the proofs only." },
};

/** The sentence src/settings/delivery.ts PROOF_ONLY_WARNING carries, in the panel's words. */
const PROOF_ONLY_WARNING = "In this mode a reader cannot check an individual page, because the converter's bytes change on every request and are not the bytes you signed. The whole file and the facts stay checkable. Pick this only when your host cannot serve Semanto's markdown.";

const WHEN_CHANGED_TEXT: Record<WhenPageChanged, { label: string; body: string }> = {
  serve_last_signed_marked_behind: { label: "Keep serving what I signed, marked as behind", body: "Readers keep getting the last signed version. Its headers say the live page has moved on until you sign a new version." },
  serve_live_marked_unsigned: { label: "Send readers to the live page, marked as unsigned", body: "Readers who ask for a changed page are sent to the current page on your site, which carries no signature; the answer says so (Trooth-Semanto-State: unsigned). The signed version stays available by its version number." },
  prompt_to_sign: { label: "Hold and ask me to sign", body: "Trooth builds the new version and waits for your signature. Readers keep getting the last signed version until you sign." },
};

function Row({ label, children, issue }: { label: string; children: ReactNode; issue?: string }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-hairline px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      <div className="text-[13.5px] font-medium text-text-primary">{label}</div>
      <div className="min-w-0 text-[13.5px] text-text-primary">
        {children}
        {issue ? (
          <p role="alert" className="mt-2 text-[13px] text-ink-emphasis">
            {issue}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({ checked, label, onChange, id, locked = false, note }: { checked: boolean; label: string; onChange?: (v: boolean) => void; id: string; locked?: boolean; note?: string }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-[13.5px] text-text-primary">
      <input id={id} type="checkbox" className="mt-0.5 size-4 rounded border-hairline" checked={checked} disabled={locked} onChange={(e: { target: { checked: boolean } }) => onChange?.(e.target.checked)} />
      <span>
        {label}
        {note ? <span className="block text-[12.5px] text-text-secondary">{note}</span> : null}
      </span>
    </label>
  );
}

export function DeliverySettingsPanel({ settings, detection, trooth_id, domain, onChange, onSave, saving = false, dirty = false, issues = [] }: DeliverySettingsPanelProps) {
  const set = <K extends keyof DeliverySettingsData>(key: K, value: DeliverySettingsData[K]) => onChange({ ...settings, [key]: value });
  const issueFor = (prefix: string) => issues.find((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))?.message;
  const checked = fmtDateTime(detection?.checked_at ?? null);
  const converterHost = settings.host === "cloudflare";

  return (
    <section aria-labelledby="delivery-settings-title" className="rounded-md border border-hairline">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
        <div>
          <h2 id="delivery-settings-title" className="text-[15px] font-medium text-text-primary">
            How your Semanto is served
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">Every reader of the same page gets the same bytes. These settings choose where they come from. The format is chosen by what a reader asks for, never by who it says it is.</p>
        </div>
        <button type="button" className="btn-primary" onClick={onSave} disabled={saving || !dirty}>
          {saving ? "Saving" : "Save changes"}
        </button>
      </div>

      <Row label="Where" issue={issueFor("where")}>
        <div className="space-y-2">
          <Toggle id="where-trooth" checked locked label={`On Trooth: api.trooth.co/public/semanto/${trooth_id}`} note="Always on. This copy is what the proofs and the public log point at." />
          <Toggle id="where-own" checked={settings.where.own_domain} label={`On your own domain: ${domain}`} note="The same bytes, served by your host through an adapter." onChange={(v) => set("where", { ...settings.where, own_domain: v })} />
        </div>
      </Row>

      <Row label="Host" issue={issueFor("host")}>
        <div className="space-y-2">
          <select className="rounded-md border border-hairline bg-paper px-2 py-1 text-[13.5px] text-text-primary" value={settings.host} onChange={(e: { target: { value: string } }) => set("host", e.target.value as HostKind)} aria-label="Host">
            {(Object.keys(HOST_TEXT) as HostKind[]).map((k) => (
              <option key={k} value={k}>
                {HOST_TEXT[k]}
              </option>
            ))}
          </select>
          {detection ? (
            <p className="text-[13px] text-text-secondary">
              Trooth saw {HOST_TEXT[detection.detected]}
              {detection.cloudflare_markdown ? ", with Cloudflare's markdown converter on" : ""}
              {detection.well_known_served ? ", serving the well-known file" : ", not yet serving the well-known file"}
              {detection.dns_pointer ? ", with the DNS pointer in place" : ""}
              {checked ? `. Checked ${checked}.` : "."}
            </p>
          ) : (
            <p className="text-[13px] text-text-secondary">Not checked yet.</p>
          )}
        </div>
      </Row>

      <Row label="Formats" issue={issueFor("formats")}>
        <div className="space-y-2">
          <Toggle id="fmt-whole" checked locked label="The whole signed file (/.well-known/trooth.semanto)" note="Always on." />
          <Toggle id="fmt-md" checked={settings.formats.markdown} label="Markdown for each page (Accept: text/markdown, or the page path with .md)" onChange={(v) => set("formats", { ...settings.formats, markdown: v })} />
          <Toggle id="fmt-jsonld" checked={settings.formats.jsonld} label="Facts as JSON-LD (facts.jsonld)" onChange={(v) => set("formats", { ...settings.formats, jsonld: v })} />
          <Toggle id="fmt-llms" checked={settings.formats.llms} label="llms.txt and llms-full.txt" onChange={(v) => set("formats", { ...settings.formats, llms: v })} />
          <Toggle id="fmt-sitemap" checked={settings.formats.sitemap_md} label="Markdown sitemap (sitemap.md)" onChange={(v) => set("formats", { ...settings.formats, sitemap_md: v })} />
        </div>
      </Row>

      <Row label="Markdown source" issue={issueFor("markdown_source")}>
        <div role="radiogroup" aria-label="Markdown source" className="space-y-3">
          {(Object.keys(MARKDOWN_MODE_TEXT) as MarkdownSource[]).map((mode) => {
            const needsConverter = mode !== "semanto_only";
            return (
              <label key={mode} className="flex items-start gap-2">
                <input type="radio" name="markdown-source" className="mt-1 size-4" checked={settings.markdown_source === mode} disabled={needsConverter && !converterHost} onChange={() => set("markdown_source", mode)} />
                <span>
                  <span className="block text-text-primary">{MARKDOWN_MODE_TEXT[mode].label}</span>
                  <span className="block text-[13px] text-text-secondary">{MARKDOWN_MODE_TEXT[mode].body}</span>
                  {needsConverter && !converterHost ? <span className="block text-[12.5px] text-text-secondary">Only Cloudflare runs a markdown converter, so this choice needs the host set to Cloudflare.</span> : null}
                </span>
              </label>
            );
          })}
          {settings.markdown_source === "cloudflare_format_semanto_proof_only" ? (
            <div role="status" className="flex items-start gap-2 rounded-md border border-hairline px-3 py-2 text-[13px] text-ink-emphasis">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{PROOF_ONLY_WARNING}</span>
            </div>
          ) : null}
        </div>
      </Row>

      <Row label="When a page changes" issue={issueFor("when_page_changed")}>
        <div role="radiogroup" aria-label="When a page changes" className="space-y-3">
          {(Object.keys(WHEN_CHANGED_TEXT) as WhenPageChanged[]).map((mode) => (
            <label key={mode} className="flex items-start gap-2">
              <input type="radio" name="when-page-changed" className="mt-1 size-4" checked={settings.when_page_changed === mode} onChange={() => set("when_page_changed", mode)} />
              <span>
                <span className="block text-text-primary">{WHEN_CHANGED_TEXT[mode].label}</span>
                <span className="block text-[13px] text-text-secondary">{WHEN_CHANGED_TEXT[mode].body}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>

      <Row label="AI use" issue={issueFor("content_signals")}>
        <div className="space-y-2">
          <Toggle id="ai-search" checked={settings.content_signals.search} label="Search: may be indexed and shown in search results" onChange={(v) => set("content_signals", { ...settings.content_signals, search: v })} />
          <Toggle id="ai-input" checked={settings.content_signals["ai-input"]} label="AI input: may be read to answer a person's question" onChange={(v) => set("content_signals", { ...settings.content_signals, "ai-input": v })} />
          <Toggle id="ai-train" checked={settings.content_signals["ai-train"]} label="AI training: may be used to train models" onChange={(v) => set("content_signals", { ...settings.content_signals, "ai-train": v })} />
          <p className="text-[13px] text-text-secondary">These three are written into the signed record and sent as the Content-Signal header (contentsignals.org). They state your terms. They do not block anyone, and they never change what is served.</p>
        </div>
      </Row>
    </section>
  );
}
