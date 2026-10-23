// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Settings: the connection to Trooth (state, Trooth ID, key id, since when),
// the last sync with Sync now, the app embed's state, Disconnect behind a
// confirmation modal (the destructive action is confirmed and named, as in
// Shopify's own disconnect flows and Built for Shopify 4.1.6), and the recent
// activity. Every connection setting is managed here, inside the admin
// (Built for Shopify 3.1.5). Polaris web components only.

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { errorResponse, shopContext } from "../lib/http.server";
import type { SyncView } from "../lib/onboarding";
import { api, when } from "../components/api";
import { SyncSteps } from "../components/sync-steps";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { service, store, shop } = await shopContext(request, context);
  const view = await service.view(shop);
  return { view, events: await store.events(shop, 10) };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "disconnect" || form.get("confirm") !== "disconnect") return { ok: false, error: "Confirm the disconnection first.", outcome: null };
  try {
    return { ok: true, error: null, outcome: await service.disconnect(shop) };
  } catch (e) {
    const res = errorResponse(e);
    const body = (await res.json()) as { error: string };
    return { ok: false, error: body.error, outcome: null };
  }
};

const EVENT_WORDS: Record<string, string> = {
  authorized: "App opened and authorized",
  connect_started: "Connection requested",
  connect_denied: "Connection declined on trooth.co",
  connect_expired: "Connection request expired",
  connect_abandoned: "Unfinished connection removed",
  connected: "Connected to Trooth",
  disconnected: "Disconnected from Trooth",
  first_sync_started: "First sync started",
  sync_started: "Sync started",
  sync_done: "Sync finished",
  sync_failed: "Sync stopped",
  key_revoked: "Store key revoked at Trooth",
  key_not_registered: "Store key was never registered with Trooth; nothing to revoke",
  revoke_refused: "Trooth refused to revoke the store key",
  revoke_unreachable: "Trooth could not be reached to revoke an unfinished connection's key",
};

/** What Disconnect did, in the merchant's words: said as it happened, not assumed. */
const DISCONNECTED_WORDS: Record<"revoked" | "not_registered" | "nothing", string> = {
  revoked: "This store is disconnected from Trooth. Its key was revoked.",
  not_registered: "This store is disconnected from Trooth. Trooth had never registered its key, so there was nothing to revoke.",
  nothing: "This store is disconnected from Trooth.",
};

export default function Settings() {
  const { view, events } = useLoaderData<typeof loader>();
  const disconnect = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [sync, setSync] = useState<SyncView>(view.sync);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const connected = view.connection.state === "connected";

  useEffect(() => setSync(view.sync), [view.sync]);

  useEffect(() => {
    if (sync.state !== "running") return;
    let stopped = false;
    const timer = setTimeout(async () => {
      const r = await api<{ sync: SyncView }>("/app/sync");
      if (stopped) return;
      if (!r.ok) return setSyncError(r.error);
      setSync(r.data.sync);
      if (r.data.sync.state !== "running") revalidator.revalidate();
    }, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);

  useEffect(() => {
    if (disconnect.state === "idle" && disconnect.data?.ok) {
      (document.getElementById("disconnect-modal") as (HTMLElement & { hideOverlay?: () => void }) | null)?.hideOverlay?.();
    }
  }, [disconnect.state, disconnect.data]);

  const syncNow = async () => {
    setSyncBusy(true);
    setSyncError(null);
    const r = await api<{ sync: SyncView }>("/app/sync", { method: "POST" });
    setSyncBusy(false);
    if (!r.ok) return setSyncError(r.error);
    setSync(r.data.sync);
  };

  const disconnecting = disconnect.state !== "idle";

  return (
    <s-page heading="Settings">
      <s-section heading="Connection to Trooth">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            {connected ? <s-badge tone="success">Connected</s-badge> : view.connection.state === "pending" ? <s-badge tone="info">Waiting for approval</s-badge> : <s-badge tone="neutral">Not connected</s-badge>}
          </s-stack>
          {view.connection.state === "connected" ? (
            <>
              <s-text>Trooth ID: {view.connection.troothId}</s-text>
              <s-text>Connected: {when(view.connection.connectedAt)}</s-text>
              <s-text color="subdued">Store key: {view.connection.kid}</s-text>
              <s-stack direction="inline" gap="small-200">
                <s-button href={view.dashboardUrl} target="_blank">
                  Open the Semanto dashboard
                </s-button>
                <s-button tone="critical" commandFor="disconnect-modal" command="--show">
                  Disconnect
                </s-button>
              </s-stack>
            </>
          ) : (
            <>
              <s-paragraph>This store is not connected. Connect it to send products to Trooth and fill in the app embed.</s-paragraph>
              <s-button variant="primary" href="/app">
                Connect to Trooth
              </s-button>
            </>
          )}
          {view.revokeError ? (
            <s-banner tone="critical" heading="Trooth still holds this store's key">
              {view.revokeError}
            </s-banner>
          ) : null}
          {disconnect.data && !disconnect.data.ok && disconnect.data.error && disconnect.data.error !== view.revokeError ? <s-banner tone="critical">{disconnect.data.error}</s-banner> : null}
          {disconnect.data?.ok ? <s-banner tone="success">{DISCONNECTED_WORDS[disconnect.data.outcome ?? "nothing"]}</s-banner> : null}
        </s-stack>
      </s-section>

      <s-section heading="Product sync">
        <s-stack direction="block" gap="base">
          {sync.state === "never" ? (
            // Polaris empty state: what will appear here, and the first step (shopify.dev, App Home patterns, Empty state).
            <s-empty-state heading="No sync has run yet">
              <s-paragraph>{connected ? "Each sync sends your active products to Trooth and shows here what Trooth signed." : "Connect this store to Trooth first. Each sync then sends your active products and shows here what Trooth signed."}</s-paragraph>
            </s-empty-state>
          ) : (
            <>
              <s-text>
                Last sync: {when(view.lastSyncAt)}
                {sync.state === "done" ? `, ${sync.run.products} ${sync.run.products === 1 ? "product" : "products"} sent, ${sync.run.records} signed ${sync.run.records === 1 ? "record" : "records"}` : ""}
              </s-text>
              <SyncSteps steps={sync.run.steps} />
            </>
          )}
          {sync.state === "failed" ? <s-banner tone="critical" heading="The last sync stopped">{sync.run.error}</s-banner> : null}
          {view.lastError && sync.state !== "failed" && !view.revokeError ? <s-banner tone="warning">{view.lastError}</s-banner> : null}
          {syncError ? <s-banner tone="critical">{syncError}</s-banner> : null}
          <s-stack direction="inline" gap="small-200">
            <s-button onClick={() => void syncNow()} {...(syncBusy || sync.state === "running" ? { loading: true } : {})} {...(!connected ? { disabled: true } : {})}>
              Sync now
            </s-button>
          </s-stack>
          {!connected ? <s-text color="subdued">Sync now needs a connection to Trooth.</s-text> : null}
        </s-stack>
      </s-section>

      <s-section heading="App embed">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={view.embed === "active" ? "success" : "neutral"}>{view.embed === "active" ? "On" : view.embed === "skipped" ? "Off (skipped during setup)" : "Off"}</s-badge>
          </s-stack>
          <s-paragraph>The app embed adds the Semanto tags to the head of your store's pages. Turn it on or off in your theme editor.</s-paragraph>
          <s-button href={view.embedLink} target="_blank">
            Open the theme editor
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Recent activity">
        {events.length === 0 ? (
          <s-empty-state heading="No activity yet">
            <s-paragraph>Connections, syncs and key changes for this store are listed here as they happen.</s-paragraph>
          </s-empty-state>
        ) : (
          <s-unordered-list>
            {events.map((e, i) => (
              <s-list-item key={`${e.at}-${i}`}>
                {EVENT_WORDS[e.action] ?? e.action}, {when(e.at)}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-modal id="disconnect-modal" heading="Disconnect this store from Trooth?">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>Trooth revokes this store's key, so it can no longer send products for your company. The app embed stops adding the Semanto tags. Product records Trooth already signed stay in your company's history.</s-paragraph>
          <s-paragraph>You can connect again at any time.</s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          tone="critical"
          variant="primary"
          {...(disconnecting ? { loading: true } : {})}
          onClick={() => disconnect.submit({ intent: "disconnect", confirm: "disconnect" }, { method: "post" })}
        >
          Disconnect
        </s-button>
        <s-button slot="secondary-actions" commandFor="disconnect-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
