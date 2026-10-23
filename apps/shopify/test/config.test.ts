// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The configuration Shopify and Cloudflare read: one access scope, managed
// installation, every webhook declared (the three compliance topics
// included) at the endpoint the Worker serves, an embed block that targets
// the head and stays inside Shopify's extension limits, no cron trigger, no
// Postgres, and the head tags the embed adds are the ones the head-tag
// adapter documents.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");

describe("shopify.app.toml", () => {
  const toml = read("shopify.app.toml");
  it("asks for read_products only and uses managed installation", () => {
    expect(/^scopes = "([^"]*)"/m.exec(toml)![1]).toBe("read_products");
    expect(toml).toMatch(/^use_legacy_install_flow = false$/m);
    expect(toml).toMatch(/^embedded = true$/m);
  });
  it("declares every webhook the app handles at /webhooks, the compliance topics included", () => {
    for (const t of ["app/uninstalled", "products/create", "products/update", "products/delete", "bulk_operations/finish"]) expect(toml).toContain(`"${t}"`);
    expect(toml).toContain('compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]');
    expect([...toml.matchAll(/uri = "([^"]+)"/g)].map((m) => m[1])).toEqual(["/webhooks", "/webhooks", "/webhooks", "/webhooks"]);
    expect(toml).toMatch(/api_version = "2026-10"/);
  });
});

describe("wrangler.toml", () => {
  const w = read("wrangler.toml");
  it("binds D1 and a queue, runs no cron, and uses no Postgres", () => {
    expect(w).toContain('binding = "DB"');
    expect(w).toContain('binding = "SYNC_QUEUE"');
    expect(w).not.toMatch(/\[triggers\]|crons/);
    expect(w).not.toMatch(/hyperdrive|postgres|DATABASE_URL/i);
    expect(w).toMatch(/max_retries = 3/);
  });
  it("sets no secret value: the client secret and the seal key are secrets, not vars", () => {
    expect(w).not.toMatch(/SHOPIFY_API_SECRET\s*=/);
    expect(w).not.toMatch(/APP_SEAL_KEY\s*=/);
  });
});

describe("theme app extension", () => {
  const liquid = read("extensions/trooth-head-tag/blocks/trooth-head.liquid");
  it("is an app embed in the head, named under 25 characters, with no merchant settings", () => {
    const schema = JSON.parse(/\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(liquid)![1]!) as { name: string; target: string; settings: unknown[] };
    expect(schema.target).toBe("head");
    expect(schema.name.length).toBeLessThan(25);
    expect(schema.settings).toEqual([]);
  });
  it("adds the two site-wide tags of adapters/head-tag, only when the store is connected", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../adapters/head-tag/README.md", import.meta.url)), "utf8");
    expect(readme).toContain('<link rel="https://trooth.co/rel/semanto" href="https://api.trooth.co/public/semanto/example-inc">');
    expect(readme).toContain('<script type="application/ld+json" src="https://api.trooth.co/public/semanto/example-inc/facts.jsonld"></script>');
    expect(liquid).toContain('<link rel="https://trooth.co/rel/semanto" href="{{ trooth_api | escape }}/public/semanto/{{ trooth_id | url_encode }}">');
    expect(liquid).toContain('<script type="application/ld+json" src="{{ trooth_api | escape }}/public/semanto/{{ trooth_id | url_encode }}/facts.jsonld"></script>');
    expect(liquid).toContain("{%- if trooth_id != blank -%}");
    expect(liquid).toContain("app.metafields.trooth.trooth_id");
  });
  it("stays inside Shopify's limits (Liquid under 100 KB, whole extension under 10 MB)", () => {
    const dir = `${root}extensions/trooth-head-tag`;
    let total = 0;
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = `${d}/${n}`;
        if (statSync(p).isDirectory()) walk(p);
        else total += statSync(p).size;
      }
    };
    walk(dir);
    expect(Buffer.byteLength(liquid)).toBeLessThan(100 * 1024);
    expect(total).toBeLessThan(10 * 1024 * 1024);
    expect(read("extensions/trooth-head-tag/shopify.extension.toml")).toMatch(/^type = "theme"$/m);
  });
});

describe("migrations", () => {
  it("every up migration has its down file next to the migrations folder", () => {
    const ups = readdirSync(`${root}migrations`).filter((f) => f.endsWith(".sql"));
    const downs = readdirSync(`${root}migrations-down`);
    for (const u of ups) expect(downs).toContain(u.replace(/\.sql$/, ".down.sql"));
  });
});

describe("listing copy", () => {
  const copy = read("submission/listing-copy.md");
  const section = (name: string) => new RegExp(`## ${name}[^\\n]*\\n\\n(.+?)\\n\\n`, "s").exec(copy)![1]!;
  it("stays within Shopify's field limits", () => {
    expect(section("App name").length).toBeLessThanOrEqual(30);
    expect(section("Subtitle").length).toBeLessThanOrEqual(62);
    expect(section("Introduction").length).toBeLessThanOrEqual(100);
    expect(section("Details").length).toBeLessThanOrEqual(500);
    const features = section("Key features").split("\n").map((l) => l.replace(/^- /, ""));
    expect(features.length).toBeGreaterThanOrEqual(3);
    expect(features.length).toBeLessThanOrEqual(5);
    for (const f of features) expect(f.length).toBeLessThanOrEqual(80);
  });
  it("cites no figure and promises no outcome in the listing fields", () => {
    for (const name of ["Subtitle", "Introduction", "Details", "Key features"]) {
      const s = section(name);
      expect([name, /\d/.test(s)]).toEqual([name, false]);
      expect([name, /\b(guarantee|best|fastest|#1|boost|rank)/i.test(s)]).toEqual([name, false]);
    }
  });
});
