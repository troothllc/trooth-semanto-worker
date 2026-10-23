// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Cloudflare Worker entry: the built React Router app handed to the
// app's fetch and queue handlers (app/worker.server.ts).

import { createRequestHandler } from "react-router";
import { makeWorker } from "../app/worker.server";
import type { Env, SyncJob } from "../app/lib/env";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);
const worker = makeWorker((request, context) => requestHandler(request, context));

export default {
  fetch: (request, env, ctx) => worker.fetch(request, env, ctx),
  queue: (batch, env) => worker.queue(batch, env),
} satisfies ExportedHandler<Env, SyncJob>;
