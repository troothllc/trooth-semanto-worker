// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Local stand-ins for the fixed upstreams, in development only (the QA stack in
// qa/, docs/program/reports/qa.md). Two variables, both ignored unless
// ENVIRONMENT is "development" and the value is a loopback http origin:
//
//   DEV_UPSTREAM_BASE   the Google OAuth, Merchant API and Business Profile
//                       hosts and api.resend.com are sent to
//                       <base>/<host><path><query> instead, so a local double
//                       answers them. Every other URL is fetched as it is.
//   DEV_DASHBOARD_BASE  where the Google callback, the connect approve link and
//                       the alert confirmation send the person (the dashboard
//                       on loopback instead of https://trooth.co/dashboard/semanto).
//
// Production never reads either: the functions answer null and the Worker's
// fetch and dashboard base are the ones it always used.

/** The hosts DEV_UPSTREAM_BASE stands in for: Google's OAuth, Merchant API and Business Profile hosts, and Resend. */
export const DEV_UPSTREAM_HOSTS: ReadonlySet<string> = new Set([
  "oauth2.googleapis.com",
  "merchantapi.googleapis.com",
  "mybusinessaccountmanagement.googleapis.com",
  "mybusinessbusinessinformation.googleapis.com",
  "api.resend.com",
]);

interface DevEnv {
  ENVIRONMENT: "development" | "production";
  DEV_UPSTREAM_BASE?: string;
  DEV_DASHBOARD_BASE?: string;
}

/** A loopback http origin (and optional path), or null. */
function loopback(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !(u.hostname === "127.0.0.1" || u.hostname === "localhost") || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** DEV_UPSTREAM_BASE when it applies (development, loopback); null otherwise, always null in production. */
export function devUpstreamBase(env: DevEnv): string | null {
  return env.ENVIRONMENT === "development" ? loopback(env.DEV_UPSTREAM_BASE) : null;
}

/** DEV_DASHBOARD_BASE when it applies (development, loopback); null otherwise, always null in production. */
export function devDashboardBase(env: DevEnv): string | null {
  return env.ENVIRONMENT === "development" ? loopback(env.DEV_DASHBOARD_BASE) : null;
}

/** fetch with the stand-in hosts sent to `base`; with no base, fetch itself. */
export function devUpstreamFetch(base: string | null, f: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  if (!base) return f;
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return f(input, init);
    }
    if (u.protocol !== "https:" || !DEV_UPSTREAM_HOSTS.has(u.hostname)) return f(input, init);
    const to = `${base}/${u.hostname}${u.pathname}${u.search}`;
    if (typeof input === "string" || input instanceof URL) return f(to, init);
    return f(new Request(to, input), init);
  };
}
