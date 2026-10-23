// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Vite build for the app: the Cloudflare Vite plugin runs the server bundle in
// the Workers runtime (dev and build), React Router builds the routes. The
// connector signer is imported from ../../adapters/shared, so that folder is
// allowed for the dev server too. HMR goes through the Shopify CLI tunnel when
// SHOPIFY_APP_URL is a tunnel address, as in Shopify's template.

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "http://localhost";
const host = new URL(appUrl).hostname;

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT || 3000),
    hmr: host === "localhost" ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 } : { protocol: "wss", host, port: Number(process.env.FRONTEND_PORT) || 8002, clientPort: 443 },
    fs: { allow: ["app", "workers", "node_modules", "../../adapters/shared"] },
  },
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react"] },
});
