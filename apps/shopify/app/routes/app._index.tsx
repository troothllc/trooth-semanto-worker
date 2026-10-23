// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's home: the setup guide until setup is done, then a short status
// page (Built for Shopify 4.2.2 and 4.2.3: onboarding that leads to completion,
// then a home page with the setup status). Five steps in the order the
// best-reviewed apps in the category use: Welcome, Connect to Trooth, Turn on
// the app embed, First sync, Done. Each step has its loading, empty, error and
// success state. Polaris web components only.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { shopContext } from "../lib/http.server";
import { EMBED_BLOCK_HANDLE } from "../lib/env";
import { embedStateFrom, nextPollDelay, POLL_INTERVAL_MS, STEPS, type Connection, type Step, type SyncView } from "../lib/onboarding";
import type { OnboardingView } from "../lib/service.server";
import { api, timeLeft, when } from "../components/api";
import { SyncSteps } from "../components/sync-steps";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  return { view: await service.view(shop) };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  const form = await request.formData();
  if (form.get("intent") === "welcome") await service.markWelcomeDone(shop);
  return { ok: true };
};

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  connect: "Connect to Trooth",
  embed: "Turn on the app embed",
  sync: "First sync",
  done: "Done",
};

export default function Home() {
  const { view } = useLoaderData<typeof loader>();
  const done = view.step === "done";
  return (
    <s-page heading="Semanto by Trooth">
      {done ? <StatusHome view={view} /> : <SetupGuide view={view} />}
      <s-section slot="aside" heading="What Semanto does">
        <s-paragraph>
          Semanto keeps a signed copy of your store's products, prices and stock with Trooth, so AI assistants and search tools can read what your store says and check that a copy matches it.
        </s-paragraph>
        <s-paragraph>Product details come from your store. Trooth records them as declared by you and signs them for your company.</s-paragraph>
      </s-section>
      <s-section slot="aside" heading="Help">
        <s-paragraph>
          Questions or problems: <s-link href="mailto:support@trooth.co">support@trooth.co</s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function SetupGuide({ view }: { view: OnboardingView }) {
  const completed = STEPS.filter((s) => view.statuses[s] === "complete").length;
  return (
    <s-section heading="Set up Semanto">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          {completed} of {STEPS.length - 1} steps done
        </s-text>
        <s-stack direction="inline" gap="small-200">
          {STEPS.filter((s) => s !== "done").map((s) => (
            <s-badge key={s} tone={view.statuses[s] === "complete" ? "success" : view.statuses[s] === "current" ? "info" : "neutral"}>
              {STEP_LABELS[s]}
            </s-badge>
          ))}
        </s-stack>
        <s-divider />
        {view.step === "welcome" ? <WelcomeStep /> : null}
        {view.step === "connect" ? <ConnectStep view={view} /> : null}
        {view.step === "embed" ? <EmbedStep view={view} /> : null}
        {view.step === "sync" ? <SyncStep view={view} /> : null}
      </s-stack>
    </s-section>
  );
}

function WelcomeStep() {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  return (
    <s-stack direction="block" gap="base">
      <s-heading>Welcome</s-heading>
      <s-paragraph>Semanto by Trooth does three things for your store:</s-paragraph>
      <s-unordered-list>
        <s-list-item>Connects this store to your company on Trooth, approved by you on trooth.co. You never paste a password or key here.</s-list-item>
        <s-list-item>Sends your active products, prices and stock to Trooth, now and whenever a product changes, so the signed copy stays current.</s-list-item>
        <s-list-item>Adds two small tags to your store's pages that point AI assistants and search tools to that signed copy. You turn them on in your theme editor and can turn them off there at any time.</s-list-item>
      </s-unordered-list>
      <s-paragraph>It reads products only. It never reads customers or orders.</s-paragraph>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="welcome" />
        <s-button variant="primary" type="submit" {...(busy ? { loading: true } : {})}>
          Get started
        </s-button>
      </fetcher.Form>
    </s-stack>
  );
}

function ConnectStep({ view }: { view: OnboardingView }) {
  const revalidator = useRevalidator();
  const [conn, setConn] = useState<Connection>(view.connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const finalCheck = useRef<string | null>(null);

  useEffect(() => setConn(view.connection), [view.connection]);

  // Poll every two seconds only while this screen is open and the session is pending and unexpired.
  useEffect(() => {
    if (conn.state !== "pending") return;
    let stopped = false;
    const delay = nextPollDelay(conn, new Date(), true);
    if (finalCheck.current !== conn.sessionId) finalCheck.current = null;
    if (delay === null) {
      if (finalCheck.current === conn.sessionId) return;
      finalCheck.current = conn.sessionId;
    }
    const run = async () => {
      const r = await api<{ connection: Connection }>("/app/connect");
      if (stopped) return;
      if (!r.ok) {
        // A failed check is shown and the next one runs on schedule; the expiry still stops polling.
        setError(r.error);
        setConn((c) => ({ ...c }));
        return;
      }
      setError(null);
      setConn(r.data.connection);
      if (r.data.connection.state === "connected") revalidator.revalidate();
    };
    // At expiry, one last check lets the server settle the session (keep an approval, or remove the pending key); then polling stops.
    const timer = setTimeout(run, delay ?? 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setBlockedUrl(null);
    // The window is opened inside the click, before any await, so the browser does not block it.
    const win = window.open("about:blank", "_blank");
    const r = await api<{ approveUrl: string; expiresAt: string; connection: Connection }>("/app/connect", { method: "POST", form: { intent: "start" } });
    setBusy(false);
    if (!r.ok) {
      win?.close();
      setError(r.error);
      return;
    }
    if (win && !win.closed) {
      win.opener = null;
      win.location.href = r.data.approveUrl;
    } else setBlockedUrl(r.data.approveUrl);
    setConn(r.data.connection);
  }, []);

  const reason = conn.state === "none" ? conn.reason : null;
  return (
    <s-stack direction="block" gap="base">
      <s-heading>Connect to Trooth</s-heading>
      {conn.state === "pending" ? (
        <>
          <s-banner tone="info" heading="Waiting for your approval on trooth.co">
            <s-stack direction="block" gap="small-200">
              <s-paragraph>A Trooth window opened. Sign in there, choose your company and press Approve. This page moves on by itself once you approve.</s-paragraph>
              <s-paragraph>The request stays open for {timeLeft(conn.expiresAt)}.</s-paragraph>
            </s-stack>
          </s-banner>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Waiting for approval" />
            <s-button href={conn.approveUrl} target="_blank">
              Open Trooth again
            </s-button>
          </s-stack>
        </>
      ) : (
        <>
          {reason === "denied" ? <s-banner tone="warning" heading="The request was declined on trooth.co">Nothing was connected. You can send a new request.</s-banner> : null}
          {reason === "expired" ? <s-banner tone="warning" heading="The request expired">Approval requests stay open for 15 minutes. Nothing was connected; send a new request when you are ready.</s-banner> : null}
          <s-paragraph>
            You approve the connection on trooth.co with your Trooth account. If you do not have one yet, you can create it there; it is the account your company's Semanto lives in.
          </s-paragraph>
          <s-button variant="primary" onClick={start} {...(busy ? { loading: true } : {})}>
            {reason ? "Send a new request" : "Connect to Trooth"}
          </s-button>
        </>
      )}
      {blockedUrl ? (
        <s-banner tone="warning" heading="Your browser blocked the Trooth window">
          <s-link href={blockedUrl} target="_blank">
            Open trooth.co to approve
          </s-link>
        </s-banner>
      ) : null}
      {error ? (
        <s-banner tone="critical" heading="The connection did not start">
          {error}
        </s-banner>
      ) : null}
      {view.lastError && conn.state === "none" ? <s-banner tone="critical">{view.lastError}</s-banner> : null}
    </s-stack>
  );
}

function EmbedStep({ view }: { view: OnboardingView }) {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [checking, setChecking] = useState(true);
  const [state, setState] = useState(view.embed);
  const [error, setError] = useState<string | null>(null);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setError(null);
    try {
      const extensions = await shopify.app.extensions();
      const next = embedStateFrom(extensions as never, EMBED_BLOCK_HANDLE);
      setState(next);
      const r = await api("/app/embed", { method: "POST", form: { state: next } });
      if (!r.ok) setError(r.error);
      else if (next === "active") revalidator.revalidate();
    } catch {
      setError("Shopify did not say whether the app embed is on. Press Check again.");
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopify]);

  // Check on arrival and each time the merchant comes back from the theme editor tab.
  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);

  const skip = async () => {
    const r = await api("/app/embed", { method: "POST", form: { state: "skipped" } });
    if (!r.ok) setError(r.error);
    else revalidator.revalidate();
  };

  return (
    <s-stack direction="block" gap="base">
      <s-heading>Turn on the app embed</s-heading>
      <s-paragraph>The app embed adds two tags to the head of your store's pages. They point AI assistants and search tools to your signed copy on Trooth. They change nothing a shopper sees.</s-paragraph>
      <s-ordered-list>
        <s-list-item>Press Turn on app embed. Your theme editor opens on the App embeds tab.</s-list-item>
        <s-list-item>Switch on Semanto by Trooth, then press Save in the theme editor.</s-list-item>
        <s-list-item>Come back to this tab. The status below changes by itself.</s-list-item>
      </s-ordered-list>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text>Status:</s-text>
        {checking ? <s-spinner size="base" accessibilityLabel="Checking the app embed" /> : <s-badge tone={state === "active" ? "success" : "neutral"}>{state === "active" ? "On" : "Off"}</s-badge>}
      </s-stack>
      <s-stack direction="inline" gap="small-200">
        <s-button variant="primary" href={view.embedLink} target="_blank">
          Turn on app embed
        </s-button>
        <s-button onClick={() => void check()} {...(checking ? { loading: true } : {})}>
          Check again
        </s-button>
        <s-button variant="tertiary" onClick={() => void skip()}>
          Skip for now
        </s-button>
      </s-stack>
      {error ? <s-banner tone="critical">{error}</s-banner> : null}
    </s-stack>
  );
}

function SyncStep({ view }: { view: OnboardingView }) {
  const revalidator = useRevalidator();
  const [sync, setSync] = useState<SyncView>(view.sync);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSync(view.sync), [view.sync]);

  // Progress is read every two seconds only while this screen is open and the sync runs.
  useEffect(() => {
    if (sync.state !== "running") return;
    let stopped = false;
    const timer = setTimeout(async () => {
      const r = await api<{ sync: SyncView }>("/app/sync");
      if (stopped) return;
      if (!r.ok) return setError(r.error);
      setSync(r.data.sync);
      if (r.data.sync.state === "done") revalidator.revalidate();
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await api<{ sync: SyncView }>("/app/sync", { method: "POST" });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSync(r.data.sync);
  };

  return (
    <s-stack direction="block" gap="base">
      <s-heading>First sync</s-heading>
      {sync.state === "never" ? (
        <>
          <s-paragraph>Send your active products to Trooth. This runs once now; after that, changes are sent as you make them.</s-paragraph>
          <s-button variant="primary" onClick={() => void start()} {...(busy ? { loading: true } : {})}>
            Start the first sync
          </s-button>
        </>
      ) : (
        <>
          <s-paragraph>{sync.state === "running" ? "Your products are on their way to Trooth. You can leave this page; the sync keeps going." : null}</s-paragraph>
          <SyncSteps steps={sync.run.steps} />
          {sync.state === "failed" ? (
            <s-banner tone="critical" heading="The sync stopped">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>{sync.run.error}</s-paragraph>
                <s-button onClick={() => void start()} {...(busy ? { loading: true } : {})}>
                  Try again
                </s-button>
              </s-stack>
            </s-banner>
          ) : null}
        </>
      )}
      {error ? <s-banner tone="critical">{error}</s-banner> : null}
    </s-stack>
  );
}

function StatusHome({ view }: { view: OnboardingView }) {
  const run = view.sync.state === "done" ? view.sync.run : null;
  return (
    <>
      <s-banner tone="success" heading="Semanto is set up" dismissible>
        Your store is connected to Trooth and your products were sent. Changes you make to products are sent as you make them.
      </s-banner>
      <s-section heading="Status">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Connection:</s-text>
            <s-badge tone="success">Connected</s-badge>
            {view.connection.state === "connected" ? <s-text color="subdued">Trooth ID {view.connection.troothId}</s-text> : null}
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>App embed:</s-text>
            <s-badge tone={view.embed === "active" ? "success" : "neutral"}>{view.embed === "active" ? "On" : "Off"}</s-badge>
            {view.embed !== "active" ? (
              <s-link href={view.embedLink} target="_blank">
                Turn on
              </s-link>
            ) : null}
          </s-stack>
          <s-text>Last sync: {when(view.lastSyncAt)}</s-text>
          {run ? (
            <s-text color="subdued">
              {run.products} products sent{run.signed === false ? "; Trooth received them without signing (your company holds its own signing key)" : ""}
            </s-text>
          ) : null}
        </s-stack>
      </s-section>
      <s-section heading="Next">
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" href={view.dashboardUrl} target="_blank">
            Open the Semanto dashboard
          </s-button>
          <s-button href="/app/settings">Settings</s-button>
        </s-stack>
      </s-section>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
