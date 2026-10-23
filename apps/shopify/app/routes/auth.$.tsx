// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The library's auth path (/auth/*): with managed installation and token
// exchange it only bounces a request that lacks a session token through
// App Bridge, as in Shopify's template.

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await getShopify(context.cloudflare.env).authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
