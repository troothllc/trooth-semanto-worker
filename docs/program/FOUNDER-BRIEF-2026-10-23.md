# Founder brief, 23 October 2026 (verbatim rules for every agent on this program)

Repos in the container (do not push; do not commit unless your brief says so; the coordinator commits as Trooth):
- /home/claude/trooth-semanto-worker (branch main) — the Semanto Worker, adapters, verifier kits.
- /home/claude/trooth-web (branch semanto-dashboard, one commit e6c6aaf on origin/main 402c021) — the trooth.co dashboard. Read its AGENTS.md: this Next.js version has breaking changes; read node_modules/next/dist/docs/ before using any Next API.
- /home/claude/trooth-os-worker-f (branch semanto-domain-claims, one commit on main 0212524) — worker-f, the API at api.trooth.co.

Rules:
1. Do not ask questions or present options. Decide, then do it. Finish every item fully: implemented, wired, tested, passing. No follow-ups, no known-issues lists.
2. Research first. For every workflow, search the web for how the most widely adopted, best-reviewed products in that category do it, and replicate that click-by-click flow (screen order, field layout, confirmation steps, empty, error and success states). Record the reference products per workflow in your report.
3. Trooth's existing design only. Before any UI, read trooth-web's design system in full (shared components, layout primitives, tokens, spacing, icons, loading, empty, error and success patterns, and the Semanto guide and its four step pages). No new colors, fonts, component libraries, spacing values or visual patterns. Reuse components; extend in place only for a genuinely new need. Reference products inform flow and interaction order only, never visual style.
4. Every new route: auth, input validation, rate limiting consistent with existing routes, audit logging where other sensitive routes log, unit tests plus the repo's existing end-to-end style. Run the full suite, lint and typecheck after each item and at the end.
5. Do not change Neon, Vercel, GitHub, UptimeRobot or Sentry settings. Code and migrations only. Every new migration is reversible (write the down migration next to it) and adds no new steady-state waker: no new crons and no polling that keeps Neon awake. Event-driven or on-demand only.
6. House rules from trooth-semanto-worker/docs/ARCHITECTURE.md apply to Semanto copy and code: no ranking noun (s-c-o-r-e), the past participles of verify and certify never describe a company or record, no ellipses, plain words, Trooth witnesses, provenance words exactly witnessed, public_record, attested, declared. In trooth-web, its own copy checks govern (check:site, check:claims, banned-terms, house-terms and the rest).
7. Commit author for any commit: Trooth <284440571+trooth-eng@users.noreply.github.com>. Never add Co-Authored-By or session lines.
8. Write your report to /home/claude/trooth-semanto-worker/docs/program/reports/<your-area>.md: files changed per repo, reference products per workflow, migrations (with their down files), env var names added, tests and results.
