// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A sync's four steps with a status each (read from Shopify, prepare, send to
// Trooth, Trooth's receipt), the per-step progress list Klaviyo's historical
// sync and Shopify's own import screens show. Polaris components only.

import type { SyncStep } from "../lib/store.server";

const LABELS: Record<SyncStep["key"], string> = {
  read: "Read products from Shopify",
  prepare: "Prepare products for Trooth",
  send: "Send to Trooth",
  receipt: "Trooth's receipt",
};

const BADGE: Record<SyncStep["state"], { tone: "neutral" | "info" | "success" | "critical"; label: string }> = {
  waiting: { tone: "neutral", label: "Waiting" },
  running: { tone: "info", label: "In progress" },
  done: { tone: "success", label: "Done" },
  failed: { tone: "critical", label: "Stopped" },
};

export function SyncSteps({ steps }: { steps: SyncStep[] }) {
  return (
    <s-stack direction="block" gap="small-200">
      {steps.map((s) => (
        <s-stack key={s.key} direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-stack direction="block" gap="none">
            <s-text type="strong">{LABELS[s.key]}</s-text>
            {s.detail ? <s-text color="subdued">{s.detail}</s-text> : null}
          </s-stack>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            {s.state === "running" ? <s-spinner size="base" accessibilityLabel={`${LABELS[s.key]} in progress`} /> : null}
            <s-badge tone={BADGE[s.state].tone}>{BADGE[s.state].label}</s-badge>
          </s-stack>
        </s-stack>
      ))}
    </s-stack>
  );
}
