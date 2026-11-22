# CLAUDE.md

Dataform Cost Check: a GitHub Action that posts BigQuery cost estimates on Dataform PRs.
Alpha. See `README.md`, `CONTRIBUTING.md` and `docs/design.md`.

## Product scope (read before adding features)

- Product strategy, the go/stop checkpoint and the decision log live in a private doc
  owned by the maintainer, not in this repo. Ask the maintainer for it if a scope question
  comes up.
- Build only what is in **v1 scope** in `docs/design.md`, or what an open milestone issue
  asks for.
- Do **not** start anything from the paid tier list, "later widening" (any
  BigQuery SQL, dbt, GitLab), or the out-of-scope list (Snowflake, Databricks, monitoring,
  automatic fixes, wall-clock forecasts). If a task drifts there, stop and say so. The
  maintainer decides, and records the decision in the strategy doc first.
- Never add telemetry or anything that sends data outside the user's CI and their own
  Google Cloud project. Trust is the product.
- User-facing text says "estimate", never "cost" as a fact.

## Working in the code

- `pnpm check` (lint, format, typecheck, tests) and `pnpm build` before finishing. Commit
  `dist/` changes; CI fails if it is stale.
- `packages/core` stays free of I/O. Only `packages/bigquery` talks to Google Cloud, and `packages/action` only calls the GitHub API to post the comment. Nothing else touches the network: no downloads at runtime (users install the Dataform CLI and `node_modules`).
- After an intended change to the PR comment, run `pnpm vitest run -u` and review the
  snapshot diff.
