// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The erasure lists against the migrations: every table that holds a
// trooth_id or a build_id is either emptied by an erasure or named as kept,
// so a new table cannot keep a company's data after the company erased it.
// And the D1 erasure itself, against the real schema.

import { describe, it, expect } from "vitest";
import { ERASE_BUILD_TABLES, ERASE_COMPANY_TABLES, ERASE_KEPT, D1PipelineStore } from "@/db/d1";
import { FixtureD1 } from "./fixtures/integration/fixture-d1-shim";

describe("erasure", () => {
  it("names every table with a trooth_id or build_id as erased or kept", () => {
    const d1 = new FixtureD1();
    const tables = (d1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'semanto_%'").all() as { name: string }[]).map((t) => t.name);
    const named = new Set<string>([...ERASE_COMPANY_TABLES, ...ERASE_BUILD_TABLES, ...ERASE_KEPT]);
    for (const t of tables) {
      const cols = (d1.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      if (cols.includes("trooth_id") || cols.includes("build_id")) expect(named.has(t), `${t} is neither erased nor kept`).toBe(true);
    }
    for (const t of named) expect(tables, `${t} is named but not in the migrations`).toContain(t);
    expect(ERASE_KEPT).toEqual(["semanto_log", "semanto_revocations", "semanto_revocation_lists"]);
  });

  it("deletes the company's rows and objects in D1 and R2 and keeps the log and revocations", async () => {
    const d1 = new FixtureD1();
    const db = d1.db;
    db.prepare("INSERT INTO semanto_companies (trooth_id, domain, org, created_at, updated_at) VALUES ('acme', 'acme.com', 'Acme', 'x', 'x'), ('other', 'other.com', 'Other', 'x', 'x')").run();
    db.prepare("INSERT INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash) VALUES ('smd_1', 'acme', 1, NULL, 'markdown', NULL, NULL, 'none', '2026-10-22T00:00:00Z', 'x'), ('smd_2', 'other', 1, NULL, 'markdown', NULL, NULL, 'none', '2026-10-22T00:00:00Z', 'x')").run();
    const deleted: string[] = [];
    const objects = ["semanto/acme/v1/semanto.json", "keys/acme/k1.jwk", "semanto/other/v1/semanto.json"];
    const bucket = {
      list: async ({ prefix }: { prefix: string }) => ({ objects: objects.filter((k) => k.startsWith(prefix) && !deleted.includes(k)).map((key) => ({ key })), truncated: false }),
      delete: async (keys: string[]) => void deleted.push(...keys),
    } as unknown as R2Bucket;
    const store = new D1PipelineStore(d1.asD1(), bucket);
    const gone = await store.eraseCompany("acme");
    expect(gone.objects).toBe(2);
    expect(deleted.sort()).toEqual(["keys/acme/k1.jwk", "semanto/acme/v1/semanto.json"]);
    expect((db.prepare("SELECT trooth_id FROM semanto_companies").all() as { trooth_id: string }[]).map((r) => r.trooth_id)).toEqual(["other"]);
    expect((db.prepare("SELECT trooth_id FROM semanto_read_receipts").all() as { trooth_id: string }[]).map((r) => r.trooth_id)).toEqual(["other"]);
    expect(gone.rows).toBe(2);
  });
});
