// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The install guide for each host on Screen F, chosen by the guide_id the API
// answers (docs/spec/setup-api.md, install.guide_id), at most four lines and
// one action each, in the words of docs/audit/workflow-research.md section 5
// (Screen F). The leaders: Certbot's one-sentence host picker, Plausible's
// per-host guides, Site Kit's "the plugin does it for you", Shopify's app
// embed deep link. The values to paste come from adapters/head-tag,
// adapters/netlify/_redirects, adapters/nginx and adapters/apache, filled
// with the company's Trooth ID. Pure.

import type { HostKind } from "./types";

export const HOST_NAMES: Record<HostKind, string> = {
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  fastly: "Fastly",
  akamai: "Akamai",
  gcore: "Gcore",
  nginx: "nginx",
  apache: "Apache",
  wordpress: "WordPress",
  shopify: "Shopify",
  webflow: "Webflow",
  squarespace: "Squarespace",
  wix: "Wix",
  head_tag: "another host",
  unknown: "an unknown host",
};

/** The Change list, in section 5's order; Fastly, Akamai and Gcore are added because the API can detect them. */
export const HOST_CHOICES: { host: HostKind; label: string }[] = [
  { host: "cloudflare", label: "Cloudflare" },
  { host: "vercel", label: "Vercel" },
  { host: "netlify", label: "Netlify" },
  { host: "wordpress", label: "WordPress" },
  { host: "shopify", label: "Shopify" },
  { host: "webflow", label: "Webflow" },
  { host: "squarespace", label: "Squarespace" },
  { host: "wix", label: "Wix" },
  { host: "nginx", label: "nginx" },
  { host: "apache", label: "Apache" },
  { host: "fastly", label: "Fastly" },
  { host: "akamai", label: "Akamai" },
  { host: "gcore", label: "Gcore" },
  { host: "head_tag", label: "Other" },
];

/** The guide_id per host, as the API answers it (src/settings/delivery.ts HOST_GUIDES). */
export const GUIDE_IDS: Record<HostKind, string> = {
  cloudflare: "cloudflare-worker",
  vercel: "vercel-middleware",
  netlify: "netlify-edge",
  fastly: "fastly-compute",
  akamai: "akamai-edgeworkers",
  gcore: "gcore-fastedge",
  nginx: "nginx-config",
  apache: "apache-config",
  wordpress: "wordpress-plugin",
  shopify: "shopify-app",
  webflow: "webflow-head-code",
  squarespace: "squarespace-code-injection",
  wix: "wix-custom-code",
  head_tag: "head-tag",
  unknown: "pick-host",
};

export interface GuideValue {
  /** What the value is, for the label and the copy button's name. */
  label: string;
  value: string;
  /** Long values show in a block, short ones on a line. */
  block?: boolean;
}

export interface Guide {
  id: string;
  /** The one action: a link to open, or a value to copy. */
  primary: { kind: "link"; label: string; href: string } | { kind: "copy"; label: string; value: string };
  /** At most four short lines, in the host's own menu words. */
  lines: string[];
  values: GuideValue[];
  /** A second, plain way in, when the host has one (Netlify's edge function, Shopify's theme code). */
  alternative?: { label: string; href: string };
}

export interface GuideInput {
  troothId: string;
  domain: string;
  /** https://api.trooth.co */
  apiBase: string;
  /** Where each guide's link goes; trooth-web passes the real ones. Keyed by guide_id. */
  links: Partial<Record<string, string>>;
}

export function headCode(publicBase: string): string {
  return [`<link rel="https://trooth.co/rel/semanto" href="${publicBase}">`, `<script type="application/ld+json" src="${publicBase}/facts.jsonld"></script>`].join("\n");
}

export function redirectsLines(publicBase: string): string {
  return [`/.well-known/trooth.semanto     ${publicBase}            200!`, `/.well-known/trooth-keys.json   ${publicBase}/keys.json  200!`].join("\n");
}

export function nginxConfig(troothId: string): string {
  return [
    "# Inside http { }",
    "include /etc/nginx/semanto-maps.conf;",
    "# Inside your server { } block",
    "include /etc/nginx/semanto-server.conf;",
    `# In both files, replace example-inc with ${troothId}`,
  ].join("\n");
}

export function apacheConfig(troothId: string): string {
  return [`# Inside your <VirtualHost>`, `Include conf-available/semanto.conf`, `# In semanto.conf, replace example-inc with ${troothId}`].join("\n");
}

export function guideFor(guideId: string, i: GuideInput): Guide | null {
  const pub = `${i.apiBase.replace(/\/+$/, "")}/public/semanto/${encodeURIComponent(i.troothId)}`;
  const link = (id: string) => i.links[id] ?? `https://trooth.co/docs/semanto/install/${id}`;
  const idValue: GuideValue = { label: "TROOTH_ID", value: i.troothId };
  const apiValue: GuideValue = { label: "TROOTH_API_BASE", value: i.apiBase.replace(/\/+$/, "") };
  const head: GuideValue = { label: "Head code", value: headCode(pub), block: true };
  switch (guideId) {
    case "cloudflare-worker":
      return { id: guideId, primary: { kind: "link", label: "Deploy to Cloudflare", href: link(guideId) }, lines: [`Pick ${i.domain} and press Deploy.`, "When Cloudflare asks for the settings, paste these two values."], values: [idValue, apiValue] };
    case "vercel-middleware":
      return { id: guideId, primary: { kind: "link", label: "Add to Vercel", href: link(guideId) }, lines: ["It adds middleware.ts and one route handler to your project.", "Set these two environment variables, then deploy."], values: [idValue, apiValue] };
    case "netlify-edge":
      return { id: guideId, primary: { kind: "copy", label: "Copy the two lines for _redirects", value: redirectsLines(pub) }, lines: ["Paste them at the top of the _redirects file in your site's publish folder, then deploy.", "For markdown on every page, use the edge function instead."], values: [{ label: "_redirects lines", value: redirectsLines(pub), block: true }], alternative: { label: "Use the edge function instead", href: link(guideId) } };
    case "fastly-compute":
      return { id: guideId, primary: { kind: "link", label: "Get the Fastly package", href: link(guideId) }, lines: ["Set these two values in the package's settings.", "Run fastly compute publish."], values: [idValue, apiValue] };
    case "akamai-edgeworkers":
      return { id: guideId, primary: { kind: "link", label: "Get the EdgeWorker bundle", href: link(guideId) }, lines: ["Set these two values as property variables.", "Upload the bundle and activate it on your property."], values: [idValue, apiValue] };
    case "gcore-fastedge":
      return { id: guideId, primary: { kind: "link", label: "Get the FastEdge app", href: link(guideId) }, lines: ["Set these two values in the app's settings.", "Attach the app to your CDN rule."], values: [idValue, apiValue] };
    case "nginx-config":
      return { id: guideId, primary: { kind: "copy", label: "Copy the config", value: nginxConfig(i.troothId) }, lines: ["Download the two files, put them in /etc/nginx, and add these lines.", "Then run nginx -t and reload nginx."], values: [{ label: "nginx config", value: nginxConfig(i.troothId), block: true }, idValue], alternative: { label: "Download the nginx files", href: link(guideId) } };
    case "apache-config":
      return { id: guideId, primary: { kind: "copy", label: "Copy the config", value: apacheConfig(i.troothId) }, lines: ["Download semanto.conf and add this line inside your VirtualHost.", "Then reload Apache."], values: [{ label: "Apache config", value: apacheConfig(i.troothId), block: true }, idValue], alternative: { label: "Download semanto.conf", href: link(guideId) } };
    case "wordpress-plugin":
      return { id: guideId, primary: { kind: "link", label: "Get the plugin", href: link(guideId) }, lines: ["Plugins, Add New, Upload, Activate. The plugin connects itself."], values: [idValue] };
    case "shopify-app":
      return { id: guideId, primary: { kind: "link", label: "Install the Shopify app", href: link(guideId) }, lines: ["After Shopify's permission screen, the theme editor opens with the Semanto embed already switched on.", "Press Save."], values: [head], alternative: { label: "Paste the head code in theme.liquid instead", href: link("head-tag") } };
    case "webflow-head-code":
      return { id: guideId, primary: { kind: "copy", label: "Copy the head code", value: headCode(pub) }, lines: ["Site settings, Custom code, Head code, Save changes, then Publish."], values: [head] };
    case "squarespace-code-injection":
      return { id: guideId, primary: { kind: "copy", label: "Copy the head code", value: headCode(pub) }, lines: ["Pages, Website Tools, Code Injection, Header, Save."], values: [head] };
    case "wix-custom-code":
      return { id: guideId, primary: { kind: "copy", label: "Copy the head code", value: headCode(pub) }, lines: ["Settings, Custom code, Add code, Head, All pages, Apply."], values: [head] };
    case "head-tag":
      return { id: guideId, primary: { kind: "copy", label: "Copy the head code", value: headCode(pub) }, lines: ["Paste it inside the head of every page, usually in your site's header settings, then publish."], values: [head] };
    default:
      return null;
  }
}
