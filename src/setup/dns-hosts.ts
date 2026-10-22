// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Which company runs a domain's DNS, read from its NS records, and the plain
// steps for adding the proof record there. Ported from the flows blueprint
// (src/lib/dns-hosts.ts). Pattern: SendGrid asks "Which DNS host do you
// use?"; Resend and Google Search Console detect the provider. Trooth reads
// the public nameservers (DNS over HTTPS) and names the host before the
// person has to know what a nameserver is. Only stable, widely documented
// nameserver patterns are listed; anything else is "your DNS host".

export interface DnsHost {
  id: string;
  name: string;
  /** Where the records live, in the host's own menu words. */
  where: string;
}

const HOSTS: { test: RegExp; host: DnsHost }[] = [
  { test: /\.ns\.cloudflare\.com\.?$/i, host: { id: "cloudflare", name: "Cloudflare", where: "Open your domain in Cloudflare, then DNS, then Records" } },
  { test: /\.domaincontrol\.com\.?$/i, host: { id: "godaddy", name: "GoDaddy", where: "Open My Products, then your domain, then DNS" } },
  { test: /\.awsdns-\d+\.(com|net|org|co\.uk)\.?$/i, host: { id: "route53", name: "Amazon Route 53", where: "Open Hosted zones, then your domain" } },
  { test: /\.registrar-servers\.com\.?$/i, host: { id: "namecheap", name: "Namecheap", where: "Open Domain List, then Manage, then Advanced DNS" } },
  { test: /\.googledomains\.com\.?$/i, host: { id: "gcloud", name: "Google Cloud DNS", where: "Open Network services, then Cloud DNS, then your zone" } },
  { test: /\.vercel-dns\.com\.?$/i, host: { id: "vercel", name: "Vercel", where: "Open Domains, then your domain, then DNS Records" } },
  { test: /\.azure-dns\.(com|net|org|info)\.?$/i, host: { id: "azure", name: "Azure DNS", where: "Open DNS zones, then your zone, then Record sets" } },
  { test: /\.digitalocean\.com\.?$/i, host: { id: "digitalocean", name: "DigitalOcean", where: "Open Networking, then Domains, then your domain" } },
  { test: /\.wixdns\.net\.?$/i, host: { id: "wix", name: "Wix", where: "Open Domains, then your domain, then Manage DNS Records" } },
  { test: /\.porkbun\.com\.?$/i, host: { id: "porkbun", name: "Porkbun", where: "Open Domain Management, then your domain, then DNS" } },
  { test: /\.ui-dns\.(com|de|org|biz)\.?$/i, host: { id: "ionos", name: "IONOS", where: "Open Domains & SSL, then your domain, then DNS" } },
  { test: /\.squarespacedns\.com\.?$/i, host: { id: "squarespace", name: "Squarespace", where: "Open Domains, then your domain, then DNS Settings" } },
];

export const UNKNOWN_HOST: DnsHost = { id: "unknown", name: "your DNS host", where: "Sign in where you bought the domain or where its DNS is managed, and open its DNS records" };

export function hostFromNameservers(nameservers: string[]): DnsHost | null {
  for (const ns of nameservers) {
    const hit = HOSTS.find((h) => h.test.test(ns.trim()));
    if (hit) return hit.host;
  }
  return null;
}

/**
 * What to type in the host's Name field. Almost every DNS host adds the
 * domain for you, so the person types only the part before it. Typing the
 * whole name is the most common mistake Vercel, Resend and SendGrid name;
 * the diagnosis catches it after the fact, this prevents it before.
 */
export function nameToType(recordHost: string, domain: string): string {
  const h = recordHost.replace(/\.$/, "").toLowerCase();
  const d = domain.replace(/\.$/, "").toLowerCase();
  if (h === d) return "@";
  return h.endsWith(`.${d}`) ? h.slice(0, -(d.length + 1)) : h;
}

/** The manual steps for one host, in plain sentences, ending with what Trooth does next. */
export function manualSteps(host: DnsHost, recordName: string, domain: string): string[] {
  const name = nameToType(recordName, domain);
  return [
    `${host.where}.`,
    "Add a new record and choose the type TXT.",
    `In Name (some hosts call it Host), type ${name}. If your host does not add ${domain} on its own, type ${recordName}.`,
    "In Value (some hosts call it Content), paste the value with the Copy button.",
    "Save it. Trooth keeps looking on its own and moves on when it finds the record.",
  ];
}
