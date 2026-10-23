// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Vitest for the Shopify app: tests under test/ run in Node (22 or newer, for
// node:sqlite and WebCrypto Ed25519), with no Cloudflare runtime, the way the
// Semanto Worker's own tests run. "@" maps to the Worker's src/, as in the
// Worker's vitest config, because the tests check the app's requests with
// the Worker's own verifier and catalog reader.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 20000 },
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
});
