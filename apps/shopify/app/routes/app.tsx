// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The embedded app's frame: every /app request is authenticated with the App
// Bridge session token (token exchange), then AppProvider loads App Bridge and
// the Polaris web components. The admin navigation has two entries, Setup and
// Settings, through s-app-nav (Built for Shopify 4.1.4).

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await getShopify(context.cloudflare.env).authenticate.admin(request);
  return { apiKey: context.cloudflare.env.SHOPIFY_API_KEY };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Setup</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
