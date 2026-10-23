// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The sync resource. POST is Sync now (one running sync per shop; a second
// press while one runs answers the running one). GET answers the sync's
// progress, read from Shopify only when a merchant's screen asks.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { errorResponse, json, shopContext } from "../lib/http.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  try {
    return json({ sync: await service.refreshProgress(shop) });
  } catch (e) {
    return errorResponse(e);
  }
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    await service.startSync(shop, "manual");
    return json({ sync: await service.syncView(shop) });
  } catch (e) {
    return errorResponse(e);
  }
};
