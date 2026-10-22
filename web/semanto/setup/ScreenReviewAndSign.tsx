// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen E, Review and sign (steps 5 and 6 of docs/audit/workflow-research.md
// section 5). Review: the facts Semanto found, in at most four sections, each
// with the page it came from, ticked "Looks right" by default so nothing needs
// a click unless it is wrong (Yoast's step-by-step confirm). Sign: one
// sentence of what signing means, the key choice, and one action (Docusign's
// single FINISH; GitHub's passkey prompt). Hosted custody: the first time,
// the person adds a passkey (Trooth's options, navigator.credentials.create);
// then each version is signed with a fresh passkey assertion over Trooth's
// single-use request for that version and root hash, which Trooth checks
// before it releases the key (W3C WebAuthn Level 3, 7.1 and 7.2). Customer
// custody shows the exact signing input to sign elsewhere and takes the
// signature back.
// A wrong fact is fixed on the site, then read again: Semanto never signs
// words the site does not say (docs/spec/setup-api.md, Review document).

"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Fingerprint } from "lucide-react";
import { SetupApiError } from "./api";
import type { ReviewDocument, ReviewState, SignAnswer, SignState } from "./types";
import { Alert, CopyButton, ErrorBox, FOCUS, LINK, OUTLINE, PLAIN, PRIMARY, ScreenHeading, StatusLine, cx } from "./ui";

export interface ScreenReviewAndSignProps {
  domain: string;
  org: string;
  review: ReviewState;
  sign: SignState;
  doc: ReviewDocument | null;
  docError?: unknown;
  onConfirm(): Promise<void>;
  onReadAgain(): Promise<void>;
  /** Hosted custody: POST sign/options, the passkey step on the device, then POST sign with the assertion. Rejects with PasskeyError or SetupApiError. */
  onPasskeySign(): Promise<SignAnswer>;
  /** Hosted custody, the first time: POST passkeys/options, navigator.credentials.create, POST passkeys. */
  onAddPasskey(): Promise<void>;
  /** Customer custody, first call: POST sign with no signature answers the signing input. */
  onRequestSigningInput(): Promise<SignAnswer>;
  /** Customer custody, second call: the base64url signature. */
  onSendSignature(signature: string): Promise<SignAnswer>;
  /** The key settings (the existing key-binding panel). */
  keysHref: string;
  focusKey: string;
}

const LONG_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const SHORT_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);

export function signedLine(org: string, signedAt: string): string {
  const d = new Date(signedAt);
  return `Signed by ${org} on ${LONG_DATE.format(d)}. Trooth witnessed the signing.`;
}

export function ScreenReviewAndSign(p: ScreenReviewAndSignProps) {
  const { domain, org, review, sign, doc } = p;
  const [wrong, setWrong] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<null | "confirm" | "sign" | "again" | "input" | "add">(null);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [keyChoice, setKeyChoice] = useState<"hosted" | "customer">(sign.custody);
  const [passkeyFailed, setPasskeyFailed] = useState<null | "sign" | "add">(null);
  /** The server said this person has no passkey yet (or the state did): show the Add a passkey step. */
  const [needPasskey, setNeedPasskey] = useState(false);
  const mustAdd = sign.custody === "hosted" && (!sign.has_passkey || needPasskey);
  const [waiting, setWaiting] = useState<Extract<SignAnswer, { object: "semanto.sign_waiting" }> | null>(null);
  const [input, setInput] = useState<Extract<SignAnswer, { object: "semanto.signing_input" }> | null>(null);
  const [signature, setSignature] = useState("");
  const [sigError, setSigError] = useState<string | null>(null);

  const confirmed = review.confirmed_at !== null;
  const signed = sign.signed_at !== null && sign.signed_version !== null && sign.signed_version === review.version;
  const version = review.version ?? 0;
  const flagged = Object.values(wrong).filter(Boolean).length;
  const changedNote = changed ?? (review.changed_since_read ? `This version changed while you were reviewing (${review.changed_urls.length} page${review.changed_urls.length === 1 ? " was" : "s were"} updated). Review the changes, then sign.` : null);

  // Customer custody: fetch the signing input as soon as the sign step opens, so it is on screen without a click.
  useEffect(() => {
    if (!confirmed || signed || sign.custody !== "customer" || input || busy) return;
    let live = true;
    setBusy("input");
    p.onRequestSigningInput()
      .then((a) => {
        if (!live) return;
        if (a.object === "semanto.signing_input") setInput(a);
        else if (a.object === "semanto.sign_waiting") setWaiting(a);
      })
      .catch((e: unknown) => live && setError(e))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed, signed, sign.custody]);

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      await p.onConfirm();
    } catch (e) {
      if (e instanceof SetupApiError && e.status === 409) setChanged(e.detail);
      else setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function passkeySign() {
    setBusy("sign");
    setError(null);
    setPasskeyFailed(null);
    try {
      const a = await p.onPasskeySign();
      if (a.object === "semanto.sign_waiting") setWaiting(a);
    } catch (e) {
      if (e instanceof Error && e.name === "PasskeyError") setPasskeyFailed("sign");
      else if (e instanceof SetupApiError && e.code === "passkey_missing") setNeedPasskey(true);
      else setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function addPasskey() {
    setBusy("add");
    setError(null);
    setPasskeyFailed(null);
    try {
      await p.onAddPasskey();
      setNeedPasskey(false);
    } catch (e) {
      if (e instanceof Error && e.name === "PasskeyError") setPasskeyFailed("add");
      else setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function sendSignature(e: { preventDefault(): void }) {
    e.preventDefault();
    const s = signature.trim();
    if (!/^[A-Za-z0-9_-]{86}$/.test(s)) {
      setSigError("Paste the 64-byte Ed25519 signature in base64url: 86 characters of letters, digits, - and _.");
      return;
    }
    setSigError(null);
    setBusy("sign");
    setError(null);
    try {
      const a = await p.onSendSignature(s);
      if (a.object === "semanto.sign_waiting") setWaiting(a);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function readAgain() {
    setBusy("again");
    setError(null);
    try {
      await p.onReadAgain();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const approvals = sign.two_officer ? (
    <div className="rounded-md border border-hairline px-4 py-3">
      <h2 className="text-[15px] font-medium text-text-primary">Approvals</h2>
      <p className="mt-1 text-[14px] text-text-secondary">Two officers of {org} approve this version before it is signed. {fmt(sign.approvals.length)} of 2 so far.</p>
      {sign.approvals.length > 0 ? (
        <ul className="mt-2">
          {sign.approvals.map((a) => (
            <li key={`${a.name}-${a.at}`} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-hairline py-1.5 text-[14px]">
              <span className="inline-flex items-center gap-1.5 text-text-primary">
                <Check className="size-3.5" aria-hidden="true" />
                {a.name}
                <span className="text-text-muted">{a.role}</span>
              </span>
              <span className="text-[13px] text-text-muted">{SHORT_TIME.format(new Date(a.at))} UTC</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;

  return (
    <section aria-labelledby="screen-e-h" data-screen="E" className="flex flex-col gap-5">
      <ScreenHeading id="screen-e-h" focusKey={p.focusKey}>
        Review and sign
      </ScreenHeading>

      {signed && sign.signed_at ? <StatusLine tone="done">{signedLine(org, sign.signed_at)}</StatusLine> : null}

      {!confirmed && !signed ? (
        <>
          <p className="text-[15px] leading-relaxed text-text-secondary">
            These are the facts Semanto found on {domain}, each with the page it came from. They are ticked as right; open one only if it is wrong.
          </p>
          {changedNote ? (
            <Alert title={changedNote} detail={review.changed_urls.length ? review.changed_urls.join(", ") : null} />
          ) : null}
          {p.docError ? <ErrorBox error={p.docError} /> : null}
          {!doc && !p.docError ? <StatusLine>Loading the facts</StatusLine> : null}
          {doc
            ? doc.sections
                .filter((s) => s.facts.length > 0)
                .map((s) => (
                  <section key={s.id} aria-labelledby={`facts-${s.id}`} className="overflow-hidden rounded-md border border-hairline">
                    <h2 id={`facts-${s.id}`} className="border-b border-hairline bg-surface-1 px-4 py-2.5 text-[15px] font-medium text-text-primary">
                      {s.title}
                    </h2>
                    <ul>
                      {s.facts.map((f) => {
                        const isWrong = !!wrong[f.id];
                        return (
                          <li key={f.id} className="border-b border-hairline px-4 py-3 last:border-b-0" data-fact={f.key}>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <p className="text-[15px] text-text-primary">{f.statement}</p>
                                <a href={f.source_url} target="_blank" rel="noreferrer" className={cx(LINK, "text-[13px] text-text-secondary")}>
                                  From {f.source_title ?? f.source_url}
                                  <ExternalLink className="size-3" aria-hidden="true" />
                                </a>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <label className={cx("inline-flex min-h-[44px] cursor-pointer items-center gap-2 px-1 text-[14px] text-text-primary")}>
                                  <input
                                    type="checkbox"
                                    checked={!isWrong}
                                    onChange={(e: { target: { checked: boolean } }) => setWrong((w) => ({ ...w, [f.id]: !e.target.checked }))}
                                    className={cx("size-4 accent-text-primary", FOCUS)}
                                  />
                                  Looks right
                                </label>
                                <button type="button" className={PLAIN} aria-expanded={isWrong} aria-controls={`fix-${f.id}`} aria-label={`Fix: ${f.statement}`} onClick={() => setWrong((w) => ({ ...w, [f.id]: !isWrong }))}>
                                  Fix
                                </button>
                              </div>
                            </div>
                            {isWrong ? (
                              <div id={`fix-${f.id}`} className="mt-2 rounded-md bg-surface-2 px-3 py-3 text-[14px] leading-relaxed text-text-secondary">
                                <p>Semanto signs your site&apos;s own words, so a wrong fact is fixed on the page it came from. Change it there, then read the site again.</p>
                                <div className="mt-1 flex flex-wrap items-center gap-3">
                                  <a href={f.source_url} target="_blank" rel="noreferrer" className={LINK}>
                                    Open the page
                                    <ExternalLink className="size-3.5" aria-hidden="true" />
                                  </a>
                                  <button type="button" className={PLAIN} disabled={busy !== null} onClick={readAgain}>
                                    Read again
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))
            : null}
          {doc && doc.pages.length > 0 ? (
            <details className="rounded-md border border-hairline px-4">
              <summary className={cx(LINK, "cursor-pointer")}>{`See the ${fmt(doc.pages.length)} pages in this version`}</summary>
              <ul className="pb-3">
                {doc.pages.map((pg) => (
                  <li key={pg.id} className="break-all py-1 text-[13px] text-text-secondary">
                    {pg.title ? `${pg.title}: ` : ""}
                    <span className="font-mono">{pg.url}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
          {flagged > 0 ? <StatusLine tone="attention">{`You marked ${flagged} fact${flagged === 1 ? "" : "s"} to fix. Fix ${flagged === 1 ? "it" : "them"} on your site and read again, or confirm as they are.`}</StatusLine> : null}
          {busy === "confirm" ? <StatusLine>Saving your review</StatusLine> : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button type="button" className={PRIMARY} disabled={busy !== null || !doc || review.version === null} onClick={confirm}>
              Confirm these facts
            </button>
          </div>
        </>
      ) : null}

      {confirmed && !signed ? (
        <>
          <p className="text-[15px] leading-relaxed text-text-primary">
            {`You are signing version ${version} of ${domain}'s Semanto record: ${fmt(review.pages_count)} pages and ${fmt(review.facts_count)} facts. Signing says these words came from your company. It does not say they are true; anyone can check who signed.`}
          </p>
          {changedNote ? <Alert title={changedNote} detail={review.changed_urls.length ? review.changed_urls.join(", ") : null} /> : null}

          <fieldset className="rounded-md border border-hairline px-4 py-3">
            <legend className="px-1 text-[14px] font-medium text-text-primary">Who keeps the signing key</legend>
            {(
              [
                { v: "hosted", label: "Trooth keeps the key, your passkey releases it" },
                { v: "customer", label: "Use our own key" },
              ] as const
            ).map((o) => (
              <label key={o.v} className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-text-primary">
                <input type="radio" name="setup-key-choice" value={o.v} checked={keyChoice === o.v} onChange={() => setKeyChoice(o.v)} className={cx("size-4 accent-text-primary", FOCUS)} />
                {o.label}
              </label>
            ))}
            {keyChoice !== sign.custody ? (
              <p className="mt-1 text-[14px] text-text-secondary">
                {keyChoice === "customer" ? "To sign with your own key, add its public key in key settings first. Then come back here." : "To let Trooth keep the key, switch to a hosted key in key settings. Then come back here."}{" "}
                <a href={p.keysHref} className={LINK}>
                  Open key settings
                </a>
              </p>
            ) : null}
          </fieldset>

          {approvals}
          {waiting ? <Alert title={waiting.reason} detail={waiting.two_officer_note ?? (waiting.approvals_missing > 0 ? `${waiting.approvals_missing} more approval${waiting.approvals_missing === 1 ? " is" : "s are"} needed before this version is signed.` : null)} /> : null}
          {passkeyFailed === "sign" ? <Alert title="Your device did not finish the passkey step. Nothing was signed. Try again." /> : null}
          {passkeyFailed === "add" ? <Alert title="Your device did not finish adding the passkey. Nothing was saved. Try again." /> : null}
          {error ? <ErrorBox error={error} /> : null}

          {keyChoice === sign.custody && mustAdd ? (
            <div className="flex flex-col gap-3 rounded-md border border-hairline px-4 py-3" data-step="add-passkey">
              <h2 className="text-[15px] font-medium text-text-primary">Add a passkey</h2>
              <p className="text-[14px] leading-relaxed text-text-secondary">
                Trooth keeps your signing key and uses it only after you confirm with a passkey on this device (fingerprint, face or PIN). You add it once; then you use it each time you sign.
              </p>
              {busy === "add" ? <StatusLine>Adding your passkey</StatusLine> : null}
              <button type="button" className={cx(PRIMARY, "self-start")} disabled={busy !== null} onClick={addPasskey}>
                <Fingerprint className="size-4" aria-hidden="true" />
                Add a passkey
              </button>
            </div>
          ) : null}

          {keyChoice === sign.custody && sign.custody === "hosted" && !mustAdd ? (
            <>
              {busy === "sign" ? <StatusLine>{`Signing version ${version}`}</StatusLine> : null}
              <button type="button" className={cx(PRIMARY, "self-start")} disabled={busy !== null} onClick={passkeySign}>
                <Fingerprint className="size-4" aria-hidden="true" />
                Sign with my passkey
              </button>
            </>
          ) : null}

          {keyChoice === sign.custody && sign.custody === "customer" ? (
            <form onSubmit={sendSignature} noValidate className="flex flex-col gap-3">
              {busy === "input" ? <StatusLine>Getting the signing input</StatusLine> : null}
              {input ? (
                <div className="rounded-md border border-hairline px-4 py-3">
                  <p className="text-[14px] text-text-secondary">Sign these exact bytes (UTF-8) with your Ed25519 private key, key id {input.kid}. Copy them; do not retype.</p>
                  <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-text-primary" data-testid="signing-input">
                    {input.signing_input}
                  </pre>
                  <div className="mt-2">
                    <CopyButton value={input.signing_input} label="Copy signing input" />
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="setup-signature" className="text-[14px] font-medium text-text-primary">
                  Signature (base64url)
                </label>
                <textarea
                  id="setup-signature"
                  rows={3}
                  value={signature}
                  onChange={(e: { target: { value: string } }) => setSignature(e.target.value)}
                  aria-invalid={sigError ? true : undefined}
                  aria-describedby={sigError ? "setup-signature-error" : undefined}
                  className={cx("w-full rounded-md border border-hairline bg-surface-1 px-3 py-2 font-mono text-[13px] text-text-primary", FOCUS)}
                />
                {sigError ? (
                  <p id="setup-signature-error" className="text-[13px] text-text-primary">
                    {sigError}
                  </p>
                ) : null}
              </div>
              {busy === "sign" ? <StatusLine>{`Signing version ${version}`}</StatusLine> : null}
              <button type="submit" className={cx(PRIMARY, "self-start")} disabled={busy !== null || !input}>
                Send the signature
              </button>
            </form>
          ) : null}
          {keyChoice !== sign.custody ? (
            <button type="button" className={cx(OUTLINE, "self-start")} onClick={() => setKeyChoice(sign.custody)}>
              Keep the current key
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

