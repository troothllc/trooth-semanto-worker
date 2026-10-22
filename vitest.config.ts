// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Vitest configuration: the tests under test/ run in Node, with "@" mapped to src/ (vitest 3 docs).

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts"], environment: "node", testTimeout: 20000 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
