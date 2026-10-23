// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Walk: every Semanto screen at a phone's width (390 by 844): no sideways
// scroll, axe clean, screenshotted.

import { load, shoot } from "./lib.mjs";

export const ROUTES = ["/dashboard/semanto", "/dashboard/semanto/read", "/dashboard/semanto/sign", "/dashboard/semanto/install", "/dashboard/semanto/monitor", "/dashboard/semanto/delivery", "/dashboard/semanto/keys", "/dashboard/semanto/receipts", "/dashboard/semanto/connectors", "/dashboard/semanto/connections", "/dashboard/semanto/company", "/dashboard/semanto/writeback", "/dashboard/semanto/sellers", "/dashboard/semanto/recalls", "/dashboard/semanto/credentials"];

export async function phone(w) {
  const page = await w.newPage("owner", { viewport: { width: 390, height: 844 } });
  for (const r of ROUTES) {
    await load(w, page, r, `phone ${r}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (wide > 1) w.note(`${r} scrolls sideways by ${wide}px at 390 wide`);
    await shoot(w, page, `phone-${r.split("/").pop()}`);
  }
}
