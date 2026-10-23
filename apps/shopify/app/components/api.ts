// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The screens' calls to the app's own resource routes. Inside the Shopify
// admin, App Bridge adds the session token to same-origin fetch requests, so
// these calls are authenticated without any token handling here.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function api<T>(path: string, init?: { method?: "GET" | "POST"; form?: Record<string, string> }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: { accept: "application/json" },
      ...(init?.form ? { body: new URLSearchParams(init.form) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: typeof body.error === "string" ? body.error : `The app answered ${res.status}. Try again.` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, status: 0, error: "The app could not be reached. Check your connection and try again." };
  }
}

/** A short "in 12 minutes" or "less than a minute" for a future time. */
export function timeLeft(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 60000) return "less than a minute";
  const m = Math.round(ms / 60000);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** A date and time in the merchant's own locale. */
export function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
