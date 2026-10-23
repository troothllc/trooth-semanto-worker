// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shopify session storage on Cloudflare D1, implementing the SessionStorage
// interface of @shopify/shopify-app-session-storage (the interface the
// template's Prisma, the KV and the other official adapters implement). The
// session is serialized with Session.toPropertyArray(true) and sealed with
// AES-256-GCM (app/lib/seal.ts), so the access token, refresh token and user
// details are never stored in the clear. Only the id, shop, online flag and
// expiry are plain columns, for lookups.

import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { open, seal } from "./seal";

export class D1SessionStorage implements SessionStorage {
  constructor(
    private readonly db: D1Database,
    private readonly sealKey: string,
  ) {}

  async storeSession(session: Session): Promise<boolean> {
    const sealed = await seal(JSON.stringify(session.toPropertyArray(true)), "shopify-session", this.sealKey);
    await this.db
      .prepare(
        "INSERT INTO shopify_sessions (id, shop, is_online, expires_at, sealed, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET shop = excluded.shop, is_online = excluded.is_online, expires_at = excluded.expires_at, sealed = excluded.sealed, updated_at = excluded.updated_at",
      )
      .bind(session.id, session.shop, session.isOnline ? 1 : 0, session.expires ? session.expires.toISOString() : null, sealed, new Date().toISOString())
      .run();
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const row = await this.db.prepare("SELECT sealed FROM shopify_sessions WHERE id = ?").bind(id).first<{ sealed: string }>();
    if (!row) return undefined;
    return this.toSession(row.sealed);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(id).run();
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    await this.db.batch(ids.map((id) => this.db.prepare("DELETE FROM shopify_sessions WHERE id = ?").bind(id)));
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const rows = await this.db.prepare("SELECT sealed FROM shopify_sessions WHERE shop = ?").bind(shop).all<{ sealed: string }>();
    const out: Session[] = [];
    for (const r of rows.results) {
      const s = await this.toSession(r.sealed);
      if (s) out.push(s);
    }
    return out;
  }

  private async toSession(sealed: string): Promise<Session | undefined> {
    try {
      const entries = JSON.parse(await open(sealed, "shopify-session", this.sealKey)) as [string, string | number | boolean][];
      return Session.fromPropertyArray(entries, true);
    } catch {
      // A row sealed with another key (after a key change) reads as no session; Shopify's token exchange makes a new one.
      return undefined;
    }
  }
}
