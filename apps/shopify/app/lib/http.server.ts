// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shared by the resource routes: authenticate the request with the App Bridge
// session token, build the shop's services, and answer JSON that is never
// cached. Errors become a plain message the screen shows next to the action
// (Built for Shopify 4.2.4), never a stack trace.

import type { AppLoadContext } from "react-router";
import { servicesFor } from "../context.server";
import { ConflictError } from "./service.server";
import { TroothError } from "./trooth-client";
import { ShopifyGraphqlError } from "./shopify-admin";
import { RetryExhausted } from "./retry";

export async function shopContext(request: Request, context: AppLoadContext) {
  const env = context.cloudflare.env;
  const s = servicesFor(env);
  const { session } = await s.shopify.authenticate.admin(request);
  return { ...s, shop: session.shop };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** A plain message and status for an error thrown by a service call. */
export function errorResponse(e: unknown): Response {
  if (e instanceof Response) throw e;
  if (e instanceof ConflictError) return json({ error: e.message }, 409);
  if (e instanceof TroothError) return json({ error: e.message }, e.status === 429 ? 429 : 502);
  if (e instanceof RetryExhausted) return json({ error: "Trooth or Shopify did not answer. Try again in a minute." }, 503);
  if (e instanceof ShopifyGraphqlError) return json({ error: e.message }, 502);
  console.error(e);
  return json({ error: "Something went wrong on our side. Try again; if it keeps happening, write to support@trooth.co." }, 500);
}
