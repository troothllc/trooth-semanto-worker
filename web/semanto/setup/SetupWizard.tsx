// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// SetupWizard: the Semanto setup path as six screens (Sign in, Your company,
// Prove your domain, What Semanto read, Review and sign, Put it on your site),
// from docs/audit/workflow-research.md section 5, against the API in
// docs/spec/setup-api.md. The server decides the step; this page reads it
// every 4 seconds backing off to 60, restarts at 4 whenever something visible
// changed, pauses while the tab is hidden and reads again the moment the tab
// or window comes back (Stripe: returning is not finishing, so the page
// always shows the server's state). There is no "check" button for DNS: the
// poll turns the record row to a check mark.
//
// Persistent on every screen: the six-step tracker with names ("Step 3 of 6:
// Prove your domain", in neutral colors), Save for later (Stripe), Help, and
// the time spent as the server measured it. One blue button per screen.
// Data goes through the SetupClient passed in (api.ts); the screens take data
// and callbacks, so all of it renders without a network.

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Circle, HelpCircle } from "lucide-react";
import { SetupApiError } from "./api";
import type { SetupClient } from "./api";
import { createPasskey, getPasskeyAssertion, later, setTitle, visibility } from "./browser";
import { POLL_SCHEDULE_MS, pollDelay, stateFingerprint } from "./poll";
import { ScreenCompany } from "./ScreenCompany";
import { ScreenInstall } from "./ScreenInstall";
import { ScreenProveDomain } from "./ScreenProveDomain";
import { ScreenReviewAndSign } from "./ScreenReviewAndSign";
import { ScreenSignIn } from "./ScreenSignIn";
import { ScreenWhatWasRead } from "./ScreenWhatWasRead";
import type { ReviewDocument, ScreenId, SetupState, SignAnswer } from "./types";
import { ErrorBox, LINK, PLAIN, OUTLINE, StatusLine, cx } from "./ui";

export const SCREENS: { id: ScreenId; name: string }[] = [
  { id: "A", name: "Sign in" },
  { id: "B", name: "Your company" },
  { id: "C", name: "Prove your domain" },
  { id: "D", name: "What Semanto read" },
  { id: "E", name: "Review and sign" },
  { id: "F", name: "Put it on your site" },
];

export interface SetupWizardProps {
  client: SetupClient;
  /** https://api.trooth.co: the public base for the values Screen F shows. */
  apiBase: string;
  /** The company, when the page knows it; otherwise the session's company is read from GET /os/semanto/setup. */
  troothId?: string | null;
  /** Whether trooth.co has a session. Without one, Screen A shows and nothing is polled. */
  signedIn: boolean;
  signIn: {
    googleHref: string;
    sendEmailLink(email: string): Promise<void>;
    linkExpiredFor?: string | null;
  };
  /** The once-only passkey offer after an email link signed the owner in. */
  passkeyOffer?: { save(): Promise<void>; dismiss(): void } | null;
  links?: {
    help?: string;
    monitoring?: string;
    /** The developer handoff: a signed link that expires in 7 days. */
    handoff?: string;
    keys?: string;
    /** Install guide links by guide_id. */
    install?: Partial<Record<string, string>>;
  };
  /** The owner came back from the DNS provider having cancelled there (Domain Connect error=access_denied). */
  domainConnectDeclined?: boolean;
  initialState?: SetupState | null;
  /** Defaults to the spec's schedule; the browser harness passes a faster one. */
  pollSchedule?: readonly number[];
  /** How long a finished screen stays before the next (section 5: two seconds). */
  holdMs?: number;
}

/** Which screen the server's step is. */
export function screenFor(state: SetupState): ScreenId {
  switch (state.step) {
    case "company":
      return "B";
    case "prove":
      return "C";
    case "read":
      return "D";
    case "review":
      return "E";
    case "install":
      return "F";
    case "done":
      return state.basic ? "D" : "F";
  }
}

function spentWords(state: SetupState | null): string | null {
  if (!state) return null;
  const s = state.timings.steps.reduce((n, t) => n + (t.spent_seconds ?? 0), 0);
  if (s <= 0) return null;
  if (s < 60) return "under a minute";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function SetupWizard(props: SetupWizardProps) {
  const { client } = props;
  const schedule = props.pollSchedule ?? POLL_SCHEDULE_MS;
  const holdMs = props.holdMs ?? 2000;
  const [state, setState] = useState<SetupState | null>(props.initialState ?? null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [offline, setOffline] = useState(false);
  const [review, setReview] = useState<ReviewDocument | null>(null);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [passkeyDone, setPasskeyDone] = useState(false);

  const idRef = useRef<string | null>(props.troothId ?? props.initialState?.trooth_id ?? null);
  const seq = useRef(0);
  const applied = useRef(0);
  const poke = useRef<(now?: boolean) => void>(() => {});

  /** Applies an answer only when it is newer than the last one applied, so a slow poll never undoes an action. */
  const apply = useCallback((n: number, s: SetupState) => {
    if (n < applied.current) return;
    applied.current = n;
    if (s.trooth_id) idRef.current = s.trooth_id;
    setState(s);
  }, []);

  // ---- the poll
  useEffect(() => {
    if (!props.signedIn) return;
    let stopped = false;
    let attempt = 0;
    let fp = stateFingerprint(state);
    let cancel: (() => void) | null = null;
    let inflight = false;

    const tick = async () => {
      cancel = null;
      if (stopped || inflight) return;
      inflight = true;
      const n = ++seq.current;
      try {
        const s = await client.state(idRef.current);
        if (stopped) return;
        apply(n, s);
        setOffline(false);
        setLoadError(null);
        const next = stateFingerprint(s);
        attempt = next === fp ? attempt + 1 : 0;
        fp = next;
        if (s.step === "done") stopped = true;
      } catch (e) {
        if (stopped) return;
        attempt += 1;
        setOffline(true);
        setLoadError(e);
      } finally {
        inflight = false;
      }
      schedule_();
    };
    const schedule_ = () => {
      if (stopped || visibility.hidden()) return;
      cancel?.();
      cancel = later(() => void tick(), pollDelay(attempt, schedule));
    };
    poke.current = (now = false) => {
      attempt = 0;
      cancel?.();
      cancel = null;
      if (now) void tick();
      else schedule_();
    };
    const offHide = visibility.onHide(() => {
      cancel?.();
      cancel = null;
    });
    const offReturn = visibility.onReturn(() => {
      if (stopped) return;
      attempt = 0;
      cancel?.();
      void tick();
    });
    void tick();
    return () => {
      stopped = true;
      cancel?.();
      offHide();
      offReturn();
    };
    // The poll starts once per sign-in; everything it reads is in refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.signedIn, client]);

  /** Runs an action that answers the setup state, applies it, and restarts the poll at 4 seconds. */
  const act = useCallback(
    async (fn: () => Promise<SetupState>) => {
      const n = ++seq.current;
      const s = await fn();
      apply(n, s);
      poke.current(false);
    },
    [apply],
  );

  // ---- the screen shown: the server's step, except that a finished C or E stays for two seconds
  const showPasskey = props.signedIn && !!props.passkeyOffer && !passkeyDone;
  const target: ScreenId | "loading" = !props.signedIn || showPasskey ? "A" : state ? screenFor(state) : "loading";
  const [shown, setShown] = useState<ScreenId | "loading">(target);
  useEffect(() => {
    if (target === shown) return;
    const hold = (shown === "C" && target !== "C" && target !== "A") || (shown === "E" && target === "F");
    if (!hold) {
      setShown(target);
      return;
    }
    return later(() => setShown(target), holdMs);
  }, [target, shown, holdMs]);

  // ---- the review document, read when the review screen opens or the version changes
  const reviewVersion = state?.review?.version ?? null;
  const reviewRoot = state?.review?.root_hash ?? null;
  useEffect(() => {
    if (shown !== "E" || !idRef.current || reviewVersion === null) return;
    let live = true;
    setReviewError(null);
    client
      .review(idRef.current)
      .then((d) => live && setReview(d))
      .catch((e: unknown) => live && setReviewError(e));
    return () => {
      live = false;
    };
  }, [shown, reviewVersion, reviewRoot, client]);

  const stepIndex = shown === "loading" ? 0 : SCREENS.findIndex((s) => s.id === shown);
  const current = SCREENS[stepIndex]!;
  const finished = state?.step === "done";
  const basicDone = finished && state?.basic;

  useEffect(() => {
    setTitle(`${shown === "loading" ? "Setting up Semanto" : `Step ${stepIndex + 1} of 6: ${current.name}`} · Trooth`);
  }, [shown, stepIndex, current.name]);

  const id = idRef.current;
  const handoff = props.links?.handoff ?? "/dashboard/semanto/handoff";
  const focusKey = `${shown}`;
  const stepState = (i: number): "done" | "current" | "upcoming" | "skipped" => {
    if (basicDone && i >= 4) return "skipped";
    if (finished && !(basicDone && i >= 4)) return "done";
    if (i < stepIndex) return "done";
    if (i === stepIndex) return "current";
    return "upcoming";
  };

  const noCompany = () => new SetupApiError({ status: 0, code: "no_company", detail: "This page lost track of your company.", fix: "Reload the page.", requestId: null, retryable: true });

  /**
   * Hosted signing: Trooth issues a single-use passkey request bound to this version and root hash
   * (POST sign/options), the device answers it (navigator.credentials.get), and the sign call carries the
   * assertion. Trooth checks it before it releases the key (W3C WebAuthn Level 3, 7.2).
   */
  async function passkeySign(): Promise<SignAnswer> {
    if (!id) throw noCompany();
    const options = await client.signOptions(id, { version: state?.review?.version ?? undefined });
    const assertion = await getPasskeyAssertion(options.publicKey);
    const a = await client.sign(id, { version: options.version, assertion });
    poke.current(true);
    return a;
  }

  /** The first time: Trooth's passkey options (POST passkeys/options), navigator.credentials.create, then POST passkeys. */
  async function addPasskey(): Promise<void> {
    if (!id) throw noCompany();
    const options = await client.passkeyOptions(id);
    const credential = await createPasskey(options.publicKey);
    await client.addPasskey(id, credential);
    await act(() => client.state(id));
  }

  async function saveForLater() {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await act(() => client.saveForLater(id, shown === "loading" ? undefined : shown));
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  let screen: ReactNode = null;
  if (shown === "A") {
    screen = (
      <ScreenSignIn
        googleHref={props.signIn.googleHref}
        onEmail={props.signIn.sendEmailLink}
        linkExpiredFor={props.signIn.linkExpiredFor ?? null}
        passkeyOffer={showPasskey}
        onSavePasskey={async () => {
          await props.passkeyOffer?.save();
          setPasskeyDone(true);
        }}
        onSkipPasskey={() => {
          props.passkeyOffer?.dismiss();
          setPasskeyDone(true);
        }}
        focusKey={focusKey}
      />
    );
  } else if (shown === "loading" || !state) {
    screen = loadError ? <ErrorBox error={loadError} /> : <StatusLine>Loading your setup</StatusLine>;
  } else if (shown === "B") {
    screen = <ScreenCompany onContinue={(b) => act(() => client.start(b))} focusKey={focusKey} />;
  } else if (shown === "C" && state.proof && state.domain && id) {
    screen = (
      <ScreenProveDomain
        domain={state.domain}
        proof={state.proof}
        read={state.read}
        onAdded={() => poke.current(true)}
        onCheckNow={() => poke.current(true)}
        onLookAgain={() => act(() => client.lookAgain(id))}
        onLater={() => act(() => client.saveForLater(id, "C"))}
        handoffHref={handoff}
        domainConnectDeclined={props.domainConnectDeclined}
        focusKey={focusKey}
      />
    );
  } else if (shown === "D" && state.read && state.domain && id) {
    screen = (
      <ScreenWhatWasRead
        domain={state.domain}
        read={state.read}
        basic={state.basic}
        finished={!!basicDone}
        onFinish={() => act(() => client.choose(id, "basic"))}
        onUpgrade={() => act(() => client.choose(id, "full"))}
        onReadAgain={() => act(() => client.readAgain(id))}
        focusKey={focusKey}
      />
    );
  } else if (shown === "E" && state.review && state.sign && state.domain && id) {
    screen = (
      <ScreenReviewAndSign
        domain={state.domain}
        org={state.org ?? state.domain}
        review={state.review}
        sign={state.sign}
        doc={review && review.version === state.review.version ? review : null}
        docError={reviewError}
        onConfirm={() => act(() => client.confirm(id, { version: state.review!.version!, root_hash: state.review!.root_hash! }))}
        onReadAgain={() => act(() => client.readAgain(id))}
        onPasskeySign={passkeySign}
        onAddPasskey={addPasskey}
        onRequestSigningInput={() => client.sign(id, { version: state.review!.version ?? undefined })}
        onSendSignature={async (signature) => {
          const a = await client.sign(id, { version: state.review!.version ?? undefined, signature });
          poke.current(true);
          return a;
        }}
        keysHref={props.links?.keys ?? "/dashboard/semanto/keys"}
        focusKey={focusKey}
      />
    );
  } else if (shown === "F" && state.install && state.monitoring && state.domain && id) {
    screen = (
      <ScreenInstall
        domain={state.domain}
        troothId={id}
        apiBase={props.apiBase}
        install={state.install}
        monitoring={state.monitoring}
        done={!!finished}
        guideLinks={props.links?.install ?? {}}
        handoffHref={handoff}
        monitoringHref={props.links?.monitoring ?? "/dashboard/semanto/monitoring"}
        onChangeHost={(host) => act(() => client.host(id, host))}
        onCheck={async () => {
          const n = ++seq.current;
          const a = await client.installCheck(id);
          apply(n, a.setup);
          poke.current(false);
          return a;
        }}
        onStartMonitoring={(b) => act(() => client.monitoring(id, b))}
        focusKey={focusKey}
      />
    );
  } else {
    screen = <StatusLine>Loading your setup</StatusLine>;
  }

  const spent = spentWords(state);
  const canSave = props.signedIn && !!id && !finished && shown !== "A";
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-6 sm:py-8" data-wizard data-shown={shown} data-step={state?.step ?? ""}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-text-muted">Setting up Semanto</p>
          <div className="flex items-center gap-1">
            {canSave && !state?.saved_for_later ? (
              <button type="button" className={PLAIN} onClick={saveForLater} disabled={saving}>
                Save for later
              </button>
            ) : null}
            <a href={props.links?.help ?? "https://trooth.co/help/semanto-setup"} target="_blank" rel="noreferrer" className={cx(LINK, "px-2 text-text-secondary no-underline hover:underline")}>
              <HelpCircle className="size-4" aria-hidden="true" />
              Help
            </a>
          </div>
        </div>
        <nav aria-label="Setup progress">
          <ol className="grid grid-cols-6 gap-1.5">
            {SCREENS.map((s, i) => {
              const st = stepState(i);
              return (
                <li key={s.id} aria-current={st === "current" ? "step" : undefined} className="flex min-w-0 flex-col gap-1.5" data-step-state={st}>
                  <span className={cx("h-1 rounded-full", st === "done" ? "bg-text-primary" : st === "current" ? "bg-text-muted" : "bg-hairline")} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only sm:flex sm:items-start sm:gap-1 sm:text-[12.5px] sm:leading-tight">
                    {st === "done" ? <Check className="mt-px size-3 shrink-0 text-text-primary" aria-hidden="true" /> : <Circle className={cx("mt-px size-3 shrink-0", st === "current" ? "text-text-primary" : "text-text-muted")} aria-hidden="true" />}
                    <span className={st === "current" ? "font-medium text-text-primary" : "text-text-secondary"}>
                      {s.name}
                      <span className="sr-only">{st === "done" ? ", done" : st === "current" ? ", current step" : st === "skipped" ? ", not in Semanto Basic" : ", not started"}</span>
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>
        <p className="flex flex-wrap gap-x-3 text-[13px] text-text-secondary">
          <span data-testid="step-line">{finished ? (basicDone ? "Semanto Basic is set up" : "Setup is finished") : `Step ${stepIndex + 1} of 6: ${current.name}`}</span>
          {spent ? <span className="text-text-muted">Time spent: {spent}</span> : null}
          {offline && state ? (
            <span role="status" aria-live="polite" className="text-ink-emphasis">
              Trooth could not be reached. Trying again.
            </span>
          ) : null}
        </p>
        {state?.saved_for_later ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-2 rounded-md border border-hairline bg-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[14px] text-text-secondary">Saved for later. You can close this page; every email from Trooth links back to this step.</span>
            <button type="button" className={OUTLINE} onClick={() => id && act(() => client.resume(id)).catch((e: unknown) => setSaveError(e))}>
              Pick up where you left off
            </button>
          </div>
        ) : null}
        {saveError ? <ErrorBox error={saveError} /> : null}
      </header>
      <div>{screen}</div>
    </div>
  );
}
