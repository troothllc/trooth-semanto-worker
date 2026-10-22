// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tailwind 3 configuration for the harness: the token color names trooth-web
// exposes (text-text-primary, border-hairline, bg-surface-2, and the rest),
// each read from the CSS variable harness.css sets for light and dark. Not
// shipped; trooth-web has its own Tailwind 4 theme with the same names.

import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default {
  content: [here("../*.tsx"), here("../*.ts"), here("./entry.js")],
  theme: {
    extend: {
      colors: {
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "ink-emphasis": "var(--ink-emphasis)",
        hairline: "var(--hairline)",
        "surface-1": "var(--surface-1)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
      },
    },
  },
  plugins: [],
};
