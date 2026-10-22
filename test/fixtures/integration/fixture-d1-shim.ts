// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: a D1 database over Node's built-in SQLite (node:sqlite) and an
// R2 bucket over a Map, with exactly the slice of the Cloudflare D1 client API
// (prepare, bind, first, all, run, batch) and R2 binding API (put, get) that
// src/db/d1.ts and src/ledger/store-d1.ts call. It lets the integration test
// run the SQL the Worker runs, against migrations/0001_semanto.sql and
// 0002_integration.sql, without a Cloudflare runtime. Not used in production.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

type Value = string | number | null;

class ShimStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Value[] = [],
  ) {}
  bind(...params: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Value))));
  }
  private plain<T>(row: unknown): T {
    return { ...(row as object) } as T;
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : this.plain<T>(row);
  }
  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => this.plain<T>(r)), success: true };
  }
  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: {} };
  }
}

export class FixtureD1 {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    // Every migration in order, as wrangler d1 migrations apply runs them.
    const dir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
    for (const m of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) this.db.exec(readFileSync(`${dir}${m}`, "utf8"));
  }
  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db, sql);
  }
  async batch(statements: ShimStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
  /** Typed as the Workers binding for the code under test. */
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

export class FixtureR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType ?? null });
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer };
  }
  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
