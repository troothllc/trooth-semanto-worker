// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Server rendering on the Worker with renderToReadableStream. Every document
// waits for all content before it is sent, for every reader alike: the answer
// never depends on User-Agent (Semanto house rule 3). Shopify's document
// headers (frame-ancestors for the admin, and the rest) are added first.

import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { getShopify } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(request: Request, responseStatusCode: number, responseHeaders: Headers, routerContext: EntryContext, loadContext: AppLoadContext) {
  getShopify(loadContext.cloudflare.env).addDocumentResponseHeaders(request, responseHeaders);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), streamTimeout + 1000);
  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
    signal: controller.signal,
    onError(error: unknown) {
      responseStatusCode = 500;
      console.error(error);
    },
  });
  await body.allReady;
  clearTimeout(timer);
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
