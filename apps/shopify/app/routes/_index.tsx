// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's address opened outside the Shopify admin. With a shop parameter
// (Shopify's own links) it goes straight to the embedded app; without one it
// says where to open the app. There is no shop-domain form: App Store
// requirement 2.3.1 forbids asking a merchant to type their myshopify address.

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return null;
};

export default function Index() {
  return (
    <main style={{ fontFamily: "Inter, sans-serif", padding: "2rem", maxWidth: "40rem" }}>
      <h1>Semanto by Trooth</h1>
      <p>Open Semanto by Trooth from your Shopify admin: Apps, then Semanto by Trooth. To add it to a store, install it from the Shopify App Store.</p>
    </main>
  );
}
