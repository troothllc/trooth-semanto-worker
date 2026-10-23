// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app embed step's resource: the screen reads the embed's state with App
// Bridge (shopify.app.extensions(), no themes scope needed) and reports it
// here, or reports that the merchant chose Skip for now.

import type { ActionFunctionArgs } from "react-router";
import { errorResponse, json, shopContext } from "../lib/http.server";

const STATES = new Set(["active", "inactive", "skipped"]);

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  if (!STATES.has(state)) return json({ error: "state is active, inactive or skipped." }, 400);
  try {
    await service.reportEmbed(shop, state as "active" | "inactive" | "skipped");
    return json({ embed: (await service.view(shop)).embed });
  } catch (e) {
    return errorResponse(e);
  }
};
