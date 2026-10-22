// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// KeyBindingPanel: how the signing key is tied to the company. The JWK Set
// served on the domain, the _trooth DNS record, the LEI match against GLEIF,
// the binding level those add up to, and one rotate action. Modeled on the
// domain and DKIM setup screens of Resend and Vercel: each row shows what is
// expected, what was found, and when it was checked.

"use client";

import { Check, X } from "lucide-react";
import { fmtDateTime } from "./format";

export type BindingLevel = "none" | "host" | "domain" | "domain_and_entity";

export const BINDING_TEXT: Record<BindingLevel, { label: string; body: string }> = {
  none: { label: "Not bound yet", body: "No key is published for this domain. Nothing can be signed until one is." },
  host: { label: "Bound to your web host", body: "The key is served from your domain's web server. Whoever runs that server could have published it." },
  domain: { label: "Bound to your domain", body: "The key is served from your web server and named in your DNS. Both have to agree, so a web host alone cannot swap it." },
  domain_and_entity: { label: "Bound to your domain and your legal entity", body: "The key is in your web server and your DNS, and the legal name on your record matches your Legal Entity Identifier at GLEIF." },
};

export interface KeyBindingData {
  kid: string;
  /** hosted: Trooth keeps the private key; customer: the company does. */
  custody: "hosted" | "customer";
  jwks: { url: string; served: boolean; checked_at: string | null };
  dns: { name: string; expected: string; present: boolean; checked_at: string | null };
  lei: { value: string | null; gleif_legal_name: string | null; record_legal_name: string | null; matches: boolean | null; checked_at: string | null };
  level: BindingLevel;
  /** When the key may be used, from the JWK Set, when set. */
  exp: string | null;
  /** The signing policy and how many accounts the workspace has. Two officers need two distinct accounts. */
  signing?: { officers: "single" | "two_officer"; accounts: number };
}

/** Shown while a two-officer company has fewer than two accounts: it cannot sign yet (src/pipeline.ts TWO_OFFICER_NOTE). */
export const TWO_OFFICER_TEXT =
  "Two-officer signing needs two different people with their own accounts. Your workspace has one account today, so a version cannot be signed until a second person joins (team seats). Turn two-officer signing off in Settings to sign with one approval.";

export interface KeyBindingPanelProps {
  binding: KeyBindingData;
  onRotate: () => void;
  rotating?: boolean;
}

function Found({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok === null) return <span className="text-text-secondary">Not checked yet</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-text-primary">
      {ok ? <Check className="size-3.5" aria-hidden="true" /> : <X className="size-3.5" aria-hidden="true" />}
      {ok ? yes : no}
    </span>
  );
}

export function KeyBindingPanel({ binding, onRotate, rotating = false }: KeyBindingPanelProps) {
  const level = BINDING_TEXT[binding.level];
  return (
    <section aria-labelledby="key-binding-title" className="rounded-md border border-hairline">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
        <div>
          <h2 id="key-binding-title" className="text-[15px] font-medium text-text-primary">
            Your signing key
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            {level.label}. {level.body}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={onRotate} disabled={rotating}>
          {rotating ? "Rotating" : "Rotate key"}
        </button>
      </div>

      {binding.signing && binding.signing.officers === "two_officer" && binding.signing.accounts < 2 ? (
        <p role="status" className="border-b border-hairline px-5 py-3 text-[13px] text-text-primary">
          {TWO_OFFICER_TEXT}
        </p>
      ) : null}

      <dl className="divide-y divide-hairline text-[13.5px]">
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <dt className="text-text-secondary">Key id</dt>
          <dd className="break-all font-mono text-[12.5px] text-text-primary">
            {binding.kid}
            <span className="ml-2 font-sans text-[12.5px] text-text-secondary">{binding.custody === "hosted" ? "Private key kept by Trooth" : "Private key kept by you"}</span>
          </dd>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <dt className="text-text-secondary">JWK Set on your domain</dt>
          <dd className="min-w-0">
            <Found ok={binding.jwks.checked_at ? binding.jwks.served : null} yes="Served" no="Not served" />
            <p className="break-all text-[12.5px] text-text-secondary">{binding.jwks.url}</p>
            {binding.jwks.checked_at ? <p className="text-[12.5px] text-text-secondary">Checked {fmtDateTime(binding.jwks.checked_at)}</p> : null}
          </dd>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <dt className="text-text-secondary">DNS record</dt>
          <dd className="min-w-0">
            <Found ok={binding.dns.checked_at ? binding.dns.present : null} yes="Found" no="Not found" />
            <p className="text-[12.5px] text-text-secondary">
              Add a TXT record at <span className="font-mono text-text-primary">{binding.dns.name}</span> with the value
            </p>
            <p className="break-all font-mono text-[12.5px] text-text-primary">{binding.dns.expected}</p>
            {binding.dns.checked_at ? <p className="text-[12.5px] text-text-secondary">Checked {fmtDateTime(binding.dns.checked_at)}</p> : null}
          </dd>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <dt className="text-text-secondary">Legal Entity Identifier</dt>
          <dd className="min-w-0">
            {binding.lei.value ? (
              <>
                <Found ok={binding.lei.matches} yes="Legal name matches GLEIF" no="Legal name does not match GLEIF" />
                <p className="font-mono text-[12.5px] text-text-primary">{binding.lei.value}</p>
                {binding.lei.gleif_legal_name ? (
                  <p className="text-[12.5px] text-text-secondary">
                    GLEIF: {binding.lei.gleif_legal_name}
                    {binding.lei.record_legal_name ? ` / your record: ${binding.lei.record_legal_name}` : ""}
                  </p>
                ) : null}
                {binding.lei.checked_at ? <p className="text-[12.5px] text-text-secondary">Checked {fmtDateTime(binding.lei.checked_at)}</p> : null}
              </>
            ) : (
              <span className="text-text-secondary">None on your record. Optional. Adding one lets readers tie the key to your legal entity, not only your domain.</span>
            )}
          </dd>
        </div>
        {binding.exp ? (
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <dt className="text-text-secondary">Key valid until</dt>
            <dd className="text-text-primary">{fmtDateTime(binding.exp)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="border-t border-hairline px-5 py-3 text-[12.5px] text-text-secondary">Rotating publishes a new key beside the old one and signs new versions with it. A version signed with the old key still checks out after the old key retires, because a key is judged at the moment it signed. Nothing already served stops working.</p>
    </section>
  );
}
