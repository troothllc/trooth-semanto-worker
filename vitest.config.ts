// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Vitest configuration: the tests under test/ run in Node, with "@" mapped to src/ (vitest 3 docs).
// apps/ holds packages with their own package.json and test runner (the Shopify app); the root suite never runs them.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts"], exclude: ["**/node_modules/**", "apps/**"], environment: "node", testTimeout: 20000 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
