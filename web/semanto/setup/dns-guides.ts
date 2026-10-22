// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The "Not your host?" switch on Screen C: the DNS hosts the server can name
// from NS records (src/setup/dns-hosts.ts), each with where its records live,
// so an owner whose host was guessed wrong can pick the right one and get the
// same five steps. The API's provider.manual_steps stay the default; these
// only answer the switch. Search Console's "Domain name provider" list is the
// leader. Pure.

export const DNS_HOSTS: { id: string; name: string; where: string }[] = [
  { id: "cloudflare", name: "Cloudflare", where: "Open your domain in Cloudflare, then DNS, then Records" },
  { id: "godaddy", name: "GoDaddy", where: "Open My Products, then your domain, then DNS" },
  { id: "namecheap", name: "Namecheap", where: "Open Domain List, then Manage, then Advanced DNS" },
  { id: "squarespace", name: "Squarespace", where: "Open Domains, then your domain, then DNS Settings" },
  { id: "wix", name: "Wix", where: "Open Domains, then your domain, then Manage DNS Records" },
  { id: "route53", name: "Amazon Route 53", where: "Open Hosted zones, then your domain" },
  { id: "gcloud", name: "Google Cloud DNS", where: "Open Network services, then Cloud DNS, then your zone" },
  { id: "vercel", name: "Vercel", where: "Open Domains, then your domain, then DNS Records" },
  { id: "azure", name: "Azure DNS", where: "Open DNS zones, then your zone, then Record sets" },
  { id: "digitalocean", name: "DigitalOcean", where: "Open Networking, then Domains, then your domain" },
  { id: "porkbun", name: "Porkbun", where: "Open Domain Management, then your domain, then DNS" },
  { id: "ionos", name: "IONOS", where: "Open Domains & SSL, then your domain, then DNS" },
  { id: "unknown", name: "Another host", where: "Sign in where you bought the domain or where its DNS is managed, and open its DNS records" },
];

/** The same five sentences src/setup/dns-hosts.ts manualSteps writes. */
export function stepsForHost(hostId: string, nameToType: string, recordName: string, domain: string): string[] {
  const host = DNS_HOSTS.find((h) => h.id === hostId) ?? DNS_HOSTS[DNS_HOSTS.length - 1]!;
  return [
    `${host.where}.`,
    "Add a new record and choose the type TXT.",
    `In Name (some hosts call it Host), type ${nameToType}. If your host does not add ${domain} on its own, type ${recordName}.`,
    "In Value (some hosts call it Content), paste the value with the Copy button.",
    "Save it. Trooth keeps looking on its own and moves on when it finds the record.",
  ];
}
