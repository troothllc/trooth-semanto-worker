// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen B, Your company (step 2 of docs/audit/workflow-research.md section
// 5). Two fields and Continue. The Website field cleans a pasted address as
// the owner types and says the one domain Semanto will use (Plausible's single
// domain field, Vercel's www prompt); Continue claims the domain and starts
// the held read at once (POST /os/semanto/setup/start), so reading overlaps
// the domain proof. The claimed-elsewhere words are the API's own (Resend's
// domain-claim notice).

"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { SetupApiError } from "./api";
import { cleanDomain } from "./domain";
import { ErrorBox, FOCUS, PRIMARY, ScreenHeading, StatusLine, cx } from "./ui";

export interface ScreenCompanyProps {
  /** Prefilled from the session when trooth.co knows the company name. */
  initialOrg?: string;
  initialWebsite?: string;
  /** Claims the domain and starts the read. Rejects with a SetupApiError. */
  onContinue(body: { org: string; domain: string }): Promise<void>;
  focusKey: string;
}

export function ScreenCompany({ initialOrg = "", initialWebsite = "", onContinue, focusKey }: ScreenCompanyProps) {
  const [org, setOrg] = useState(initialOrg);
  const [site, setSite] = useState(initialWebsite);
  const [touched, setTouched] = useState({ org: false, site: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = cleanDomain(site);
  const orgError = org.trim() ? null : "Type your company's name.";
  const showSiteError = !check.ok && (touched.site || (!check.empty && site.length > 3));

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setTouched({ org: true, site: true });
    if (orgError || !check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await onContinue({ org: org.trim(), domain: site.trim() });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const domain = check.ok ? check.domain : null;
  const unreachable = error instanceof SetupApiError && error.code === "upstream_unavailable" && domain;
  return (
    <section aria-labelledby="screen-b-h" data-screen="B" className="flex flex-col gap-5">
      <ScreenHeading id="screen-b-h" focusKey={focusKey}>
        Your company
      </ScreenHeading>
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="setup-org" className="text-[14px] font-medium text-text-primary">
            Company name
          </label>
          <input
            id="setup-org"
            type="text"
            autoComplete="organization"
            value={org}
            onChange={(e: { target: { value: string } }) => setOrg(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, org: true }))}
            aria-invalid={touched.org && orgError ? true : undefined}
            aria-describedby={touched.org && orgError ? "setup-org-error" : undefined}
            className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[15px] text-text-primary", FOCUS)}
          />
          {touched.org && orgError ? (
            <p id="setup-org-error" className="text-[13px] text-text-primary">
              {orgError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="setup-website" className="text-[14px] font-medium text-text-primary">
            Website
          </label>
          <input
            id="setup-website"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="example.com"
            value={site}
            onChange={(e: { target: { value: string } }) => setSite(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, site: true }))}
            aria-invalid={showSiteError ? true : undefined}
            aria-describedby="setup-website-note"
            className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[15px] text-text-primary", FOCUS)}
          />
          <p id="setup-website-note" role="status" aria-live="polite" className="min-h-[20px] text-[13px]">
            {check.ok ? (
              <span className="inline-flex items-center gap-1.5 text-text-secondary">
                <Check className="size-3.5" aria-hidden="true" />
                We will use {check.domain}
              </span>
            ) : showSiteError ? (
              <span className="text-text-primary">{check.message}</span>
            ) : null}
          </p>
        </div>
        {busy && domain ? <StatusLine>Checking {domain}</StatusLine> : null}
        {unreachable ? (
          <ErrorBox error={new SetupApiError({ status: 0, code: "unreachable", detail: `We could not reach ${domain}. Check the spelling, or that the site is online.`, fix: null, requestId: (error as SetupApiError).requestId, retryable: true })} />
        ) : error ? (
          <ErrorBox error={error} />
        ) : null}
        <button type="submit" className={cx(PRIMARY, "w-full sm:w-auto sm:self-start")} disabled={busy}>
          Continue
        </button>
      </form>
    </section>
  );
}
