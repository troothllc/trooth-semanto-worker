// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Screen A, Sign in (step 1 of docs/audit/workflow-research.md section 5).
// It does not hold its own sign-in: Continue with Google links into trooth.co's
// existing sign-in, and Continue with email calls trooth.co's magic link
// sender through the callback the page passes. Copies GitHub's passkey prompt
// at sign-in, Shopify's "sign up with the account you already have", and
// Trooth's own magic-link finding: the link signs the owner in directly, and
// the passkey offer comes once, after sign-in, never as a gate.

"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { LINK, OUTLINE, PLAIN, PRIMARY, FOCUS, ScreenHeading, StatusLine, cx } from "./ui";

export interface ScreenSignInProps {
  /** trooth.co's Google sign-in, with the return address to this page. */
  googleHref: string;
  /** Sends trooth.co's sign-in link to the address. Rejects with plain words when it could not. */
  onEmail(email: string): Promise<void>;
  /** Set when the owner opened an expired link and a new one was sent. */
  linkExpiredFor?: string | null;
  /** After the email link signed the owner in: offer a passkey once. */
  passkeyOffer?: boolean;
  onSavePasskey?(): Promise<void>;
  onSkipPasskey?(): void;
  focusKey: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ScreenSignIn({ googleHref, onEmail, linkExpiredFor, passkeyOffer, onSavePasskey, onSkipPasskey, focusKey }: ScreenSignInProps) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"start" | "sending" | "sent">("start");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [passkey, setPasskey] = useState<"offer" | "saving" | "failed">("offer");

  if (passkeyOffer) {
    return (
      <section aria-labelledby="screen-a-h" data-screen="A" className="flex flex-col gap-4">
        <ScreenHeading id="screen-a-h" focusKey={`${focusKey}-passkey`}>
          You are signed in
        </ScreenHeading>
        <p className="text-[15px] leading-relaxed text-text-secondary">Save a passkey on this device, and next time you sign in with your fingerprint, face or device PIN instead of an email link.</p>
        {passkey === "failed" ? (
          <StatusLine tone="attention">Your device did not save the passkey. You can sign in with your email link every time, or try again later in Settings.</StatusLine>
        ) : passkey === "saving" ? (
          <StatusLine>Waiting for your device</StatusLine>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {passkey !== "failed" ? (
            <button
              type="button"
              className={PRIMARY}
              disabled={passkey === "saving"}
              onClick={async () => {
                setPasskey("saving");
                try {
                  await onSavePasskey?.();
                } catch {
                  setPasskey("failed");
                }
              }}
            >
              Save a passkey
            </button>
          ) : null}
          <button type="button" className={passkey === "failed" ? OUTLINE : LINK} onClick={() => onSkipPasskey?.()}>
            {passkey === "failed" ? "Continue" : "Not now"}
          </button>
        </div>
      </section>
    );
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const v = email.trim();
    if (!EMAIL.test(v)) {
      setFieldError("Type your work email, like ada@example.com.");
      return;
    }
    setFieldError(null);
    setSendError(null);
    setPhase("sending");
    try {
      await onEmail(v);
      setPhase("sent");
    } catch (err) {
      setPhase("start");
      setSendError(err instanceof Error && err.message ? err.message : "The sign-in link was not sent. Check your connection, then try again.");
    }
  }

  return (
    <section aria-labelledby="screen-a-h" data-screen="A" className="flex flex-col gap-4">
      <ScreenHeading id="screen-a-h" focusKey={focusKey}>
        Sign in to Semanto by Trooth
      </ScreenHeading>
      <p className="text-[15px] leading-relaxed text-text-secondary">Use your work email so Trooth can match you to your company&apos;s domain.</p>
      {linkExpiredFor ? <StatusLine tone="attention">That link has expired. We sent a new one to {linkExpiredFor}.</StatusLine> : null}

      {phase === "sent" ? (
        <div className="rounded-md border border-hairline bg-surface-1 px-4 py-4">
          <p className="flex items-start gap-2 text-[15px] text-text-primary">
            <Mail className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span role="status" aria-live="polite">
              We sent a sign-in link to {email.trim()}. Open it on this device to continue.
            </span>
          </p>
          <button type="button" className={cx(PLAIN, "mt-2")} onClick={() => setPhase("start")}>
            Use a different email
          </button>
        </div>
      ) : (
        <>
          <a href={googleHref} className={cx(OUTLINE, "w-full sm:w-auto")}>
            Continue with Google
          </a>
          <form onSubmit={submit} noValidate className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="setup-work-email" className="text-[14px] font-medium text-text-primary">
                Work email
              </label>
              <input
                id="setup-work-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e: { target: { value: string } }) => setEmail(e.target.value)}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? "setup-work-email-error" : undefined}
                placeholder="ada@example.com"
                className={cx("min-h-[44px] w-full rounded-md border border-hairline bg-surface-1 px-3 text-[15px] text-text-primary", FOCUS)}
              />
              {fieldError ? (
                <p id="setup-work-email-error" className="text-[13px] text-text-primary">
                  {fieldError}
                </p>
              ) : null}
            </div>
            {phase === "sending" ? <StatusLine>Sending your sign-in link</StatusLine> : null}
            {sendError ? <StatusLine tone="attention">{sendError}</StatusLine> : null}
            <button type="submit" className={cx(PRIMARY, "w-full sm:w-auto sm:self-start")} disabled={phase === "sending"}>
              Continue with email
            </button>
          </form>
        </>
      )}
    </section>
  );
}
