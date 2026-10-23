// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: a D1 database over Node's built-in SQLite (node:sqlite) with
// the slice of the D1 client API the app calls (prepare, bind, first, all,
// run, batch), loaded with migrations/ in order as wrangler applies them. The
// same construction as the Semanto Worker's test/fixtures/integration/
// fixture-d1-shim.ts. Not used in production.

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
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : ({ ...(row as object) } as T);
  }
  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...(r as object) }) as T), success: true };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export class FixtureD1 {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
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
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
