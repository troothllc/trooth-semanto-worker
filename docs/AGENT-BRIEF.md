# Working in this repository (read before writing a line)

1. Read `docs/ARCHITECTURE.md` first. Its house rules are checked by review; a violation is a defect.
2. Read `src/core/*.ts` to learn the shared API. Do not change `src/core` except to add a small export you need; if you do, say so in your final report with the exact diff.
3. Stay inside the folders assigned to you. Other agents work in the other folders at the same time. Do not touch `src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts` or `wrangler.toml` unless the brief assigns them to you. If you need a dependency, implement it instead; this worker ships with `hono` only.
4. Every module is pure where it can be. Handlers and D1 or R2 or fetch calls go behind small interfaces (a `ports.ts` in your folder) with an in-memory implementation used by tests. Tests run in Node with vitest and must not need a Cloudflare runtime: `npx vitest run test/<area>.test.ts` and `npx tsc --noEmit` must both pass for your files before you finish.
5. Fixtures are files under `test/fixtures/<area>/`, named as fixtures, with plainly fictional companies (Acme Inc, acme.com). No fixture figure is ever presented as a measurement.
6. Banned words about a company, fact or record: score, verified, certified. Banned everywhere: ellipses (three dots). Full hashes, full paths.
7. Never choose a format by User-Agent. Accept header or path suffix only, through `src/core/negotiate.ts`.
8. Plain words in every string a person reads. Short sentences. No marketing claims. Nothing that says AI will prefer or trust the content.
9. File header on every file: `// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary`, `// Copyright (c) 2026 Trooth, LLC`, then a comment that says what the module does and the leader practice or standard it follows (with the standard's number: RFC, draft name, product doc date).
10. When done, write `docs/reports/<area>.md`: what you built (file by file), the requirement numbers it covers, what is stubbed or needs a founder step (keys, accounts, DNS), and how to run the tests. Then stop. Do not commit; the coordinator commits.
