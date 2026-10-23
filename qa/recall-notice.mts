// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The recall notice a company signs with its own key, built the way the Worker
// builds one (src/commerce/recalls.ts buildRecall: object "semanto.recall" and
// its smn_ content id). Reads the notice input as JSON on stdin, writes the
// notice as JSON. Used by qa/walk/recalls.mjs for the customer-held upload.
import { buildRecall } from "../src/commerce/recalls";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  process.stdout.write(JSON.stringify(await buildRecall(JSON.parse(input))));
});
