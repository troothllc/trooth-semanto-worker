// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// React Router framework settings: server rendering on the Cloudflare Worker
// through Vite's environment API (the setup Cloudflare's React Router template uses).

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: { v8_viteEnvironmentApi: true },
} satisfies Config;
