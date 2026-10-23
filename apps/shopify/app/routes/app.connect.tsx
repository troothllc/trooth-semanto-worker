// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Connect screen's resource. POST starts (or hands back) the connect
// session; GET checks it once. The screen calls GET every two seconds while
// it is open and the session has not expired (app/lib/onboarding.ts,
// nextPollDelay), and stops otherwise; nothing polls in the background.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { errorResponse, json, shopContext } from "../lib/http.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  try {
    return json({ connection: await service.poll(shop) });
  } catch (e) {
    return errorResponse(e);
  }
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { service, shop } = await shopContext(request, context);
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const started = await service.connect(shop);
    const view = await service.view(shop);
    return json({ approveUrl: started.approveUrl, expiresAt: started.expiresAt, connection: view.connection });
  } catch (e) {
    return errorResponse(e);
  }
};
