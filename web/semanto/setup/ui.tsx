// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The small parts every setup screen shares: the button classes (one blue
// btn-primary per screen, outline btn-secondary and plain btn-ghost for the
// rest, every one at least 44 pixels tall with a visible focus ring), the copy
// button (GitHub Primer's clipboard pattern: the label changes to "Copied"
// only after the write resolves, announced politely, reverted after 2
// seconds; a refused write selects the value so the keyboard shortcut works),
// the screen heading that takes focus on arrival, and the error box that
// always says what to do and gives the request id (Geist, Primer).

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { copyText, later, type Focusable } from "./browser";
import { errorWords } from "./api";

export const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1A73E8]";
export const TAP = "min-h-[44px]";
/** The one blue action on a screen. */
export const PRIMARY = `btn-primary inline-flex ${TAP} items-center justify-center gap-2 px-4 ${FOCUS}`;
/** Outline: a real action that is not the screen's one primary. */
export const OUTLINE = `btn-secondary inline-flex ${TAP} items-center justify-center gap-2 px-4 ${FOCUS}`;
/** Plain: a quiet action or a way out. */
export const PLAIN = `btn-ghost inline-flex ${TAP} items-center justify-center gap-2 px-3 text-text-secondary hover:text-text-primary ${FOCUS}`;
/** A plain text link that still meets the 44 pixel target. */
export const LINK = `inline-flex ${TAP} items-center gap-1 text-[14px] text-text-primary underline underline-offset-2 hover:text-text-secondary ${FOCUS}`;

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The screen's one h1. It takes focus when the screen arrives, so a screen reader starts at the top; it is not a control, so it draws no ring. */
export function ScreenHeading({ children, id, focusKey }: { children: string; id: string; focusKey: string }) {
  const el = useRef<Focusable | null>(null);
  useEffect(() => {
    el.current?.focus({ preventScroll: false });
  }, [focusKey]);
  return (
    <h1
      id={id}
      tabIndex={-1}
      ref={(node: Focusable | null) => {
        el.current = node;
      }}
      className="text-[24px] font-normal leading-tight tracking-[-0.01em] text-text-primary focus:outline-none sm:text-[28px]"
    >
      {children}
    </h1>
  );
}

/** label is the full accessible name and starts with "Copy" ("Copy record value"); text is what shows (default "Copy"). */
export function CopyButton({ value, label, primary = false, text }: { value: string; label: string; primary?: boolean; text?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const field = useRef<{ select(): void } | null>(null);
  useEffect(() => {
    if (state !== "copied") return;
    return later(() => setState("idle"), 2000);
  }, [state]);
  useEffect(() => {
    if (state === "failed") field.current?.select();
  }, [state]);
  async function run() {
    setState((await copyText(value)) ? "copied" : "failed");
  }
  const visible = text ?? "Copy";
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={run} aria-label={state === "copied" ? label.replace(/^Copy\b/, "Copied") : label} data-copy-value={value} className={primary ? PRIMARY : OUTLINE}>
        {state === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        <span>{state === "copied" ? "Copied" : visible}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied" : ""}
      </span>
      {state === "failed" ? (
        <span className="flex flex-col gap-1">
          <span className="text-[13px] text-text-secondary">Your browser did not allow copying. The value is selected: press Ctrl+C or Command+C.</span>
          <input
            readOnly
            aria-label={label.replace(/^Copy\s*/, "")}
            value={value}
            ref={(node: { select(): void } | null) => {
              field.current = node;
            }}
            className={cx("w-full rounded border border-hairline bg-surface-1 px-2 py-2 font-mono text-[13px] text-text-primary", FOCUS)}
          />
        </span>
      ) : null}
    </span>
  );
}

/** A value shown exactly, with its copy button. Long values wrap; nothing is cut off. */
export function ValueRow({ label, value, block = false }: { label: string; value: string; block?: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-b border-hairline py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-secondary">{label}</p>
        {block ? (
          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed text-text-primary">{value}</pre>
        ) : (
          <p className="mt-1 break-all font-mono text-[14px] text-text-primary">{value}</p>
        )}
      </div>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

/** A problem in plain words: what happened, what to do, and the id to quote. */
export function Alert({ title, detail, fix, requestId }: { title: string; detail?: string | null; fix?: string | null; requestId?: string | null }) {
  return (
    <div role="alert" className="rounded-md border border-hairline bg-surface-2 px-4 py-3">
      <p className="flex items-start gap-2 text-[14px] font-medium text-text-primary">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ink-emphasis" aria-hidden="true" />
        <span>{title}</span>
      </p>
      {detail ? <p className="mt-1 pl-6 text-[14px] text-text-secondary">{detail}</p> : null}
      {fix ? <p className="mt-1 pl-6 text-[14px] text-text-secondary">{fix}</p> : null}
      {requestId ? (
        <p className="mt-1 pl-6 text-[13px] text-text-muted">
          Request id <span className="font-mono">{requestId}</span>
        </p>
      ) : null}
    </div>
  );
}

/** An error from the client, shown with Alert. */
export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  const w = errorWords(error);
  return <Alert title={title ?? w.detail} detail={title ? w.detail : null} fix={w.fix} requestId={w.requestId} />;
}

/** A status line that is read out when it changes (aria-live polite). */
export function StatusLine({ children, tone = "working" }: { children: ReactNode; tone?: "working" | "done" | "attention" | "idle" }) {
  return (
    <p role="status" aria-live="polite" data-tone={tone} className={cx("text-[14px] leading-relaxed", tone === "attention" ? "text-text-primary" : "text-text-secondary")}>
      {children}
    </p>
  );
}
