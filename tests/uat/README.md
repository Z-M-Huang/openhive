# OpenHive UAT Suites

Two UAT suites live here with distinct scopes:

## `openhive-uat.spec.ts` — Per-AC acceptance matrix (Playwright)

Run with `bun run test:uat`.

One test per acceptance criterion (AC-1 through AC-71) and UAT scenario (UAT-1+).
Mechanical checks against committed artifacts: source files, ADR docs, system rules,
package.json, and test fixtures. Does **not** spin up the running server; it asserts
that the code under `src/`, `docs/`, and `system-rules/` matches the contracts frozen
in `.vcp/plan/ralph-openhive-v051-alignment.md`.

## `concurrency.spec.ts` — Spawn/concurrency UAT (Playwright)

End-to-end checks for `spawn_team` truthful queued return and per-policy concurrency
behavior. Runs under `playwright test`.

## Separation guarantees

- AC/UAT IDs in `openhive-uat.spec.ts` never overlap with other spec names.
- Both suites are Playwright-style (`test()`, `expect()` from `@playwright/test` or
  `playwright/test`).
- `openhive-uat.spec.ts.meta.test.ts` is the only vitest file in this folder; it is
  run by `bun run test` (vitest), not by `bun run test:uat` (playwright).
  `playwright.config.ts` scopes discovery to `*.spec.ts` so the meta test is not
  picked up by playwright.

If you add a new AC or scenario, decide which suite it belongs in:
- Contract/inventory check → `openhive-uat.spec.ts`
- Running-system behavior → a dedicated `*.spec.ts` alongside `concurrency.spec.ts`
