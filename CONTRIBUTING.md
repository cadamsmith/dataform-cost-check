# Contributing

Thanks for helping. The project is in alpha, so open an issue before starting anything
large.

## Setup

You need Node 22 or later and Corepack (bundled with Node).

```sh
corepack enable
pnpm install
pnpm check   # lint, format check, typecheck, tests
pnpm build   # bundle the action into dist/
pnpm readme  # regenerate the README's sample comment after a change to the comment
```

`pnpm install` (or `pnpm run prepare`) turns on a pre-commit hook (`.githooks/pre-commit`) that checks formatting
and that `dist/` is up to date, so CI does not have to tell you. Skip it once with
`git commit --no-verify`.

Claude Code users get three project skills in `.claude/skills/`: `release`, `sandbox-check`
and `demo-deck`.

## Layout

```
action.yml          # Action metadata; runs dist/index.cjs on node24
dist/               # Committed, bundled action. Rebuild with `pnpm build`.
packages/
  core/             # Pure logic: diff, pricing, limits, comment rendering. No network.
  dataform/         # Adapter: runs and parses `dataform compile --json` into core models
  bigquery/         # Dry runs, partition lookups and job history against the BigQuery API
  action/           # Action entry point: inputs, config, sticky comment, exit code
fixtures/
  sample-project/   # Tiny Dataform project used in tests
packages/dataform/test/fixtures/
  sample-compile.json  # Compile output of fixtures/sample-project (CLI 3.1.6)
  js-compile.json      # A JavaScript-defined project: publish() loops, includes/, pre-operations
  jit-compile.json     # Just-in-time actions (.jitCode(), compilation_mode: "jit"), CLI 3.1.6
  v2-cli-stdout.txt    # Raw stdout of a Dataform 2.x CLI (2.9.0), log line included
docs/
  design.md         # Decisions, scope, and the hard cases
```

The key seam is the `DryRunner` interface in `core`:
`estimate(sql, location) -> { bytes, partitionedTables? } | { error, errorKind }`. Tests use
`FakeDryRunner`. `error` is BigQuery's message, for the job log only; the comment shows
`errorKind`. Only `packages/bigquery` talks to Google Cloud; `packages/action` also calls the
GitHub API to post the comment.

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

## Releases

Run `pnpm release X.Y.Z`: it bumps every place the version lives (the four
`packages/*/package.json` files, the log line, README and SECURITY.md), then checks and
builds. Merge that as a PR, then push an annotated tag `vX.Y.Z` on `main`. The release workflow re-runs `pnpm check`, refuses to release if `dist/` does not
match a fresh build, attests `dist/index.cjs` once the repository is public, and creates
the GitHub release, and moves the major tag (`v0`). Users should pin the tag's full commit SHA.
