// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's routes. /app is the embedded admin (onboarding at /app, settings at
// /app/settings); /app/connect, /app/sync and /app/embed are the JSON
// resources those screens call; /auth/* is the library's auth path. Webhooks
// are not React Router routes: workers/app.ts answers POST /webhooks first.

import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("auth/*", "routes/auth.$.tsx"),
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("connect", "routes/app.connect.tsx"),
    route("sync", "routes/app.sync.tsx"),
    route("embed", "routes/app.embed.tsx"),
  ]),
] satisfies RouteConfig;
