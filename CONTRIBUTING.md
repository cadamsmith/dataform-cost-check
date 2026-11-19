# Contributing

Thanks for helping. The project is pre-alpha, so open an issue before starting anything
large.

## Setup

You need Node 22 or later and Corepack (bundled with Node).

```sh
corepack enable
pnpm install
pnpm check   # lint, format check, typecheck, tests
pnpm build   # bundle the action into dist/
```

## Layout

```
action.yml          # Action metadata; runs dist/index.cjs on node24
dist/               # Committed, bundled action. Rebuild with `pnpm build`.
packages/
  core/             # Pure logic: diff, pricing, limits, comment rendering. No network.
  dataform/         # Adapter: runs and parses `dataform compile --json` into core models
  bigquery/         # DryRunner implementation against the BigQuery API
  action/           # Action entry point: inputs, config, sticky comment, exit code
fixtures/
  sample-project/   # Tiny Dataform project used in tests
docs/
  design.md         # Decisions, scope, and the hard cases
```

The key seam is the `DryRunner` interface in `core`:
`estimate(sql, location) -> { bytes } | { error }`. Tests use `FakeDryRunner`. Only
`packages/bigquery` may touch the network.

The core engine takes plain compiled SQL. Dataform is the first adapter on top of it, so
other SQL sources can be added later without a rewrite.

## Stack

- TypeScript (strict) on Node, pnpm workspaces. Packages export their TypeScript source
  directly (`"exports": "./src/index.ts"`); there is no per-package build.
- Vitest for tests, including snapshot tests of the rendered comment. After an intended
  change to the comment, run `pnpm vitest run -u` and review the snapshot diff.
- ESLint (typescript-eslint, strict type-checked) and Prettier.
- esbuild bundles `packages/action` to a single CommonJS file in `dist/`.

## Pull requests

- Run `pnpm check` and `pnpm build`, and commit `dist/` changes. CI fails if `dist/` is
  stale.
- User-facing text says "estimate", never "cost" as a fact.
- Keep `core` free of I/O.
