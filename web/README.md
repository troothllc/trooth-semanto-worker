# Semanto dashboard panels for trooth-web

Six React 19 TypeScript components, written to the conventions of `src/components/semanto/semanto-record-panel.tsx` in trooth-web: `"use client"`, lucide-react icons, Tailwind with the token classes (`text-text-primary`, `text-text-secondary`, `text-ink-emphasis`, `border-hairline`, `btn-primary`), plain words in every string, blue only on the one action.

Every panel takes plain data and callbacks. None fetches, so the parent page owns loading, errors and saving the way `SemantoRecordPanel` does, and the panels render the same in Storybook, tests and the dashboard.

| Component | Shows | Data it takes |
| --- | --- | --- |
| `DeliverySettingsPanel` | Where the Semanto is served, the host, the formats, the markdown source (three modes; the proof-only mode shows a warning), what happens when a page changes, the AI use switches | `DeliverySettingsData`, `onChange(next)`, `onSave()` |
| `ConsistencyMonitorPanel` | Mismatches between the signed record and each public surface, grouped by severity, each with the signed value, the surface value and one action | `Mismatch[]`, `last_run_at`, `surfaces_checked` |
| `ReadReceiptsPanel` | Reads by day; named agents only when their request signature checked out, otherwise "unproven reader"; Trooth's own hourly checks in their own column; a CSV link | `ReadReceiptDay[]`, `csv_href`, `total_reads` |
| `KeyBindingPanel` | JWK Set served, DNS record, LEI match, the binding level, one rotate action | `KeyBindingData`, `onRotate()` |
| `BasicUpgradeCard` | What Basic has and lacks, one action | `has[]`, `lacks[]`, `action` |

## Dropping in

Copy `web/semanto/` to `src/components/semanto/` in trooth-web. `format.ts` holds the shared date and count formatting; it matches the `fmtDate` in `semanto-record-panel.tsx` so dates read the same across the page.

`web/types/react-shim.d.ts` and `web/tsconfig.json` exist only so these files typecheck inside the worker repository, which has no React. Do not copy them. In this repository: `npx tsc -p web/tsconfig.json --noEmit`.

## Rules these panels keep

- No number is computed from a guess. Counts come from the parent, which gets them from the API; `METRICS_DEFINITIONS.md` says how each is counted.
- An agent is named only when proven by its signed request; everything else is "unproven reader".
- None of the three banned words about a company appears.
- Blue (`btn-primary`) appears once per panel, on the action.

## The setup wizard

`web/semanto/setup/` holds the Semanto setup wizard: the six screens of `docs/audit/workflow-research.md` section 5, a data client for `docs/spec/setup-api.md`, and a browser harness that walks every click. See `web/semanto/setup/README.md` and `docs/reports/setup-wizard.md`. Unlike the panels above, the wizard's container fetches (through the client passed in); its screens take data and callbacks.
