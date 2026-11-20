# Design

This document records the decisions behind **Dataform Cost Check**, the free Action:
its scope, how the check works, and the hard cases it must handle.

## Audience and prior art

- Audience: teams on BigQuery who manage transformations with Dataform and review changes
  on GitHub.
- dbt already has this: `dbt-costgate` (open source) and dbt's own cost feature. Dataform
  has no packaged PR check.
- The nearest Dataform tool is [`ashish10alex/dj`](https://github.com/ashish10alex/dj), a
  CLI that reads `dataform compile --json` and reports dry-run cost per table and tag. A
  useful reference for the compile output shape.
- The author's `dataform-dag` VS Code extension has a TypeScript core that parses Dataform
  graphs. Its users are the launch audience, and its parsing code may be reusable in
  `packages/dataform`.

## Decisions

| Decision                                                                              | Reason                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Ship the core check as a free, open-source GitHub **Action**, not a hosted GitHub App | It runs in the customer's own CI, so we never hold their credentials. Being free removes a reason to say no. |
| Core engine takes **plain compiled SQL**; Dataform is the first adapter on top        | Lets the audience widen later (any BigQuery SQL, maybe dbt) without a rewrite.                               |
| Launch positioned as "the cost check for Dataform"                                    | Nobody else claims it. Widen only after the adoption checkpoint (see issue #3).                              |
| No wall-clock **forecast**                                                            | Dry runs return bytes, not duration. A guessed time would undermine trust in the dollar figure.              |
| Past runtime shown as labelled history (optional)                                     | Cheap context from job history. Never presented as a prediction.                                             |
| Paid tier is a later, separate product                                                | Only built if the adoption checkpoint is met.                                                                |

## Scope

### Free Action (this repository, v1)

- Sticky PR comment with the total monthly cost change
- Bytes scanned before and after, per changed model
- Flags the most common cause: a lost partition filter
- One configurable spending limit that can fail the check
- Last refresh duration per table, as history, when permissions allow

### Paid tier (not in this repository; do not build here)

- Cost history across PRs; budgets per team or dataset with approval rules
- Slack alerts and a monthly finance summary
- Estimate versus actual after merge, in dollars and minutes
- Slot-based (Editions) pricing, where cost is runtime multiplied by capacity
- Receives only numbers and table names, never SQL or data

### Out of scope for v1

- dbt support, Snowflake, Databricks (the product depends on BigQuery's free dry run)
- GitLab
- Monitoring of costs already running
- Automatic fixes

## How the check works

1. Trigger on `pull_request`, never `pull_request_target`. Fork PRs must degrade to
   "no report", never to exposed secrets.
2. Check out base and head. Run `dataform compile --json` on each.
3. Diff the two compilation results by action target. A model is "changed" if its
   compiled query differs, or it is new or removed. (`core.diffModels`)
4. For each changed model, dry-run the base SQL and the head SQL against BigQuery and read
   the bytes that would be processed. (`DryRunner`)
5. Price it: `delta_TiB x price_per_TiB x runs_per_day x 30`. (`core.monthlyDelta`)
   `runs_per_day` comes from an override for the model name, then the highest override
   among its tags, then `default_runs_per_day`.
6. Post or update one sticky comment, found by a hidden marker. Exit non-zero if the total
   exceeds `limit_monthly` (strictly greater; exactly at the limit passes).

### Package boundaries

- `core`: pure logic and types (`Model`, `ModelChange`, `Estimate`, `Report`, `Config`,
  `DryRunner`). No I/O.
- `dataform`: compiles a project and maps the JSON output to `Model[]`.
- `bigquery`: the only package that touches the network.
- `action`: reads inputs and `dataform-cost-check.yml`, wires the pieces, posts the comment, sets
  the exit code.

## Hard cases

These are the real product. Each is designed for from the start, even where v1 only
reports "not estimated" with a reason.

- **Incremental models.** The compiled output has an incremental and a full-refresh query.
  Estimate the incremental one as steady state (`core.steadyStateSql`); mention the
  full-refresh estimate separately. The full-refresh query of the head version gets its own dry
  run (`Estimate.fullRefreshBytes`), shown as a note and never added to the monthly figure.
  If only that dry run fails, the note is left out and the estimate stands. Known gap: a
  newly added incremental model's incremental query reads its own table, which does not
  exist yet, so it is reported as not estimated.
- **New upstream tables.** A dry run fails when the SQL references a table the same PR
  creates. Report it plainly as not estimated; do not guess. When a head dry run fails and
  the query quotes the target of a model the PR adds (`core.readsNewTarget`), the reason
  names that table and says it can be estimated once the table exists. Only direct reads
  are caught: a query that reaches the new table through a new view keeps BigQuery's error.
- **Every dry run fails.** The check fails when every changed model that needed a dry run
  came back not estimated, and quotes the first error (`action.dryRunFailure`). It
  points at project setup only when that error is about permissions, a disabled API or
  unknown; a rejected query or a missing table points to the job log instead. That
  pattern usually means a misconfigured project (no `bigquery.jobs.create`, the API
  disabled, a wrong project ID), and passing green would hide it. Chosen in #13. Models that
  read a table the same PR creates are left out of the count, since their failure is
  expected and explained (this was the rule's first known false failure).
- **Required partition filter dropped.** A table with `requirePartitionFilter` rejects a
  query without that filter, so a head dry run fails while base passed. The query would
  fail in production too, so the check fails with that reason, naming the model
  (`action.partitionFilterFailure`), instead of blaming project setup. These models are
  left out of the "every dry run fails" count. A base dry run failing this way is not the
  change's fault and stays an ordinary failure. Detected from BigQuery's message ("without
  a filter over column"), the one error kind with no reason code of its own; the column
  name stays in the job log. Chosen 2026-11-20 (milestone 2, #2).
- **No query text in the comment.** The comment carries model names, bytes and
  estimates, never query text. That includes BigQuery's error messages, which can quote
  string literals and identifiers from the compiled SQL, and on a public repository the
  comment is public. The runner sorts each failed dry run into a kind
  (`DryRunErrorKind`: permission denied, API not enabled, not found, required partition
  filter missing, query error, unknown) from the HTTP status and BigQuery's error reasons
  (`bigquery.classifyError`). The comment and the "every dry run fails" message name the
  kind; BigQuery's message goes to the job log only (`action.failureDetails`), as plain
  log lines rather than warnings, since annotations show on the pull request. Chosen in #24.
- **Comment size.** GitHub rejects a comment over 65,536 characters, and editing
  `includes/` or `workflow_settings.yaml` can change every model at once. The comment
  always starts with the headline and verdict and ends with the footer. Rows are sorted
  by the size of their monthly change (byte change breaks ties), and rows, notes and "not
  estimated" entries stop before 60,000 characters (`core.COMMENT_MAX_LENGTH`), ending with
  a count of the models left out. The job summary gets the same report capped at 900,000
  (the step summary limit is 1 MiB), and the job log gets it uncapped. Chosen in #25.
- **Views.** Creating a view costs nothing; the cost lands on whatever reads it. Views are
  skipped with that reason.
- **Assertions, operations, pre/post operations.** Decide per type: estimate, skip, or
  label. v1 skips assertions and operations with a reason.
- **Regions.** On-demand price varies by location. The price is configurable first:
  `price_per_tib_by_location` overrides `price_per_tib` for a model whose location
  matches, without regard to case (`core.pricePerTibFor`), and the comment lists the
  overrides. A model with no location uses `price_per_tib`. Built-in region-aware prices
  come later. Each model carries its BigQuery location.
  Dataform 3 has no location per action, so a project has one location:
  `defaultLocation` in `workflow_settings.yaml`. That setting is optional. When it is
  missing, models carry no location and the dry run sends none, so BigQuery picks the
  location from the datasets the query reads. Falling back to `US` was rejected: it would
  make every dry run in an EU or regional project fail with an unclear error.
- **Slot-based pricing.** Bytes do not map to dollars. The comment says so. A team can
  set `price_per_tib: 0` (or 0 for a location) to say so in config. A model priced at 0
  shows bytes scanned and "bytes only" instead of dollars, and is left out of the dollar
  figure. When every estimated model is at 0, the headline says bytes are shown, not
  dollars, and a set `limit_monthly` is reported as unable to apply (in the comment and as
  a warning) instead of passing silently. No bytes-based limit: v1 keeps one spending
  limit. Chosen in #26.
- **Estimate is an upper bound.** Say "estimate", never "cost". Do not deduct the monthly
  free tier.
- **Partition filter detection.** A heuristic, surfaced as `Estimate.likelyCause` with the
  table name (`core.partitionFilterCause`). It fires when base and head both read the same
  partitioned table, and head reads at least 10 times as many bytes and at least 1 GiB more
  per run. The runner learns which tables are partitioned from the dry run's
  `referencedTables` and one `tables.get` per table (time or range partitioning). That
  lookup is extra detail: if it fails (no access, a wildcard table, rate limits), the
  table is left out and the estimate stands. A dry run over a view lists only the view,
  not the tables under it, so no cause is named there: by design, the check does not
  guess through views. Not detected: a filter that still exists but no longer prunes
  (for example, wrapped in a function).
