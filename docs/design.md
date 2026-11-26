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
- Last refresh duration per table, as history, when permissions allow. Opt-in: shown only
  when the team grants job-listing access (`bigquery.jobs.listAll`), read from the free
  `jobs.list` API, never from a billed `INFORMATION_SCHEMA` query. For teams on slot-based
  (Editions) pricing it includes slot-hours, labelled as history and never as dollars;
  Editions dollars stay in the paid tier. Decided 2026-11-20. Built the same day
  (`bigquery.readRefreshHistory`): newest successful job per table over twice the slowest cadence in the config (7 to 30
  days, `core.historyDays`; 14 for weekly runs), matched by
  the job's DDL or destination table, or, for a SCRIPT (an incremental with pre-operations),
  by its own `INSERT INTO` / `MERGE` / `CREATE OR REPLACE TABLE` target, matched in memory
  and never shown. Child jobs cannot be listed together with `allUsers`, which is why the
  script's SQL is matched. Checked live against a real Dataform run.
  Bytes read (#118): each row also shows the run's `totalBytesProcessed`, the same measure
  as the dry-run figures (billed differed by under 1% in the #119 runs, from per-child MiB
  rounding). For a SCRIPT it is the parent job, which equals the sum of its children,
  pre-operations included (#119). An incremental model's run is marked "(full refresh)"
  when it rebuilt the table (`CREATE_TABLE_AS_SELECT`, or `CREATE [OR REPLACE] TABLE` in
  the script) rather than adding to it: a full refresh read about 4× an incremental run
  (#119). Models a dry run can't size (pre-operations variables or temp tables) point to
  that figure. It is the base version only, so it stays out of the monthly figure and the
  limit.

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
   compiled query differs, or it is new or removed. Also when its runs per day or price per
   TiB differ, for example a new tag that `runs_per_day` matches: that changes the spend
   with the same SQL. (`core.diffModels`)
4. For each changed model, dry-run the base SQL and the head SQL against BigQuery and read
   the bytes that would be processed. (`DryRunner`)
5. Price each side at its own frequency and price, and take the difference:
   `head_TiB x head_price x head_runs_per_day x 30 - base_TiB x base_price x base_runs_per_day x 30`.
   `runs_per_day` comes from an override for the model name, then the highest override
   among its tags, then `default_runs_per_day`. When it changes, the comment shows both
   (`1 → 24`).
6. Post or update one sticky comment, found by a hidden marker. When no models changed, only
   update an existing comment (so it never shows a stale estimate); don't create one. Exit
   non-zero if the total exceeds `limit_monthly` (strictly greater; exactly at the limit
   passes).

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
  If only that dry run fails, the note is left out and the estimate stands.
  **Full refresh line.** Teams that rebuild from scratch (for example, after fixing data)
  pay for full refreshes outside any schedule. When an incremental model is among the
  changes, the comment adds one line: one rebuild of the changed models, in dollars, before
  and after (`Report.fullRefresh`). Tables and assertions count at their normal query,
  incrementals at their full-refresh query (base gets its own dry run too), a new
  incremental at its first run, views at 0; each side at its own price. An incremental whose
  pre-operations block only its incremental query (a declared checkpoint) still gets its
  full refresh sized. Never added to the monthly figure or the limit. Changed models whose
  rebuild could not be sized (a failed dry run, a temp table in pre-operations) are counted
  as left out, never silently dropped. For tables alone the line would repeat the per-run
  figures, so it is not shown. Chosen 2026-11-22. A newly added incremental model's incremental query reads its own table, which does not
  exist yet, so it gets no monthly estimate; the comment says so and gives its first run, the
  full refresh, in bytes. It is left out of the "every dry run fails" count (#38).
- **Unique-key incremental models.** With a `uniqueKey`, each run is a MERGE into the
  existing table, which also reads that table; the dry run covers only the SELECT. Measured
  2026-11-20: the MERGE dry run counted the SELECT's bytes plus the whole 6.76 MB target
  (43,068,800 against 36,313,200), and a non-partition filter on the target did not reduce
  it.
  Checked against real Dataform runs 2026-11-23 (696 MB partitioned source): a full refresh
  and an append incremental processed exactly their dry-run bytes (833,879,814); the MERGE
  processed 1,445,892,829, the SELECT plus the whole target. When the incremental query reads
  the model's own table (the usual `MAX(...)` from `self()` filter), `updatePartitionFilter`
  did not reduce that, in the billed run or in dry runs of several filter forms; with a
  literal source filter it did (1.33 GB to 0.78 GB). So when the query quotes its own target
  (`Estimate.merge.readsOwnTable`), the note says the whole table is read and that the
  update filter does not limit it. A dry run of the MERGE statement itself matched the
  billed bytes.
  **Sizing the MERGE (#114), 2026-11-23.** `dataform compile --json` has no MERGE, because
  Dataform takes the column list from the existing table at run time. `core.mergeSql`
  copies Dataform's BigQuery `mergeInto` from CLI 3.1.x character for character,
  `incrementalPredicates` included. CLI 3.0.x and core 2.x differ only in alias names
  (`T`/`S` for `DATAFORM_DEST`/`DATAFORM_SOURCE`) and whitespace, which do not change the
  bytes (both forms dry-ran to 258,085,598 on the sandbox's `terms_daily`). A test runs
  Dataform's own `mergeInto` out of the installed bundle and compares: exactly for 3.1.8,
  up to quoting, aliases and whitespace for older versions. It runs in CI (CLI 3.1.8) and
  nightly (the oldest and newest 3.x CLI, and core 2.9.0), so drift fails a build (it caught
  the 3.1.x change, and 3.1.8's, which quotes the source columns in the update set and
  moves the query's parentheses to the caller: #132). Models with
  `incrementalStrategy: INSERT_OVERWRITE` (3.1+) run a different script, a staging table
  and a partition-replacing MERGE, so they get no MERGE sizing. They get their own note
  instead: the figure is the query alone, a lower bound (`Estimate.insertOverwrite`). `DryRunner.table` reads the target's columns and logical size with
  a free `tables.get` (Data Viewer covers it). Three outcomes (`Estimate.merge.sizing`):
  - `merge`: the MERGE dry run succeeded on every side that has a key. Its bytes replace
    the query's, so the figure and the monthly change are exact.
  - `range`: the MERGE dry run failed. BigQuery requires `bigquery.tables.updateData` on the
    target even for a dry run (checked with the sandbox's read-only account: denied). The
    figure stays the query alone, and the note gives the range up to the query plus the
    whole table. BigQuery's message goes to the job log. No read-only query reproduces the
    MERGE's figure: on a 2.4 GB date-partitioned copy of Google Trends, a source filtered
    to one date made the MERGE read only that date's partition of the target (153 MB, twice
    the 77 MB query), where the query plus a scan of the target, with or without the update
    filter, gave 2.52 GB or 400 MB. With a source reading `MAX()` from the target, the MERGE
    read 4.90 GB; the query plus the filtered target gave 3.07 GB, too low. The query plus
    the whole target was at or above the MERGE in every case tried, so it is the top of the
    range. The README says not to grant write access just for this.
  - `query`: the table could not be looked up (it does not exist yet, or no access). As
    before: the figure is the query alone, a lower bound. The note now says the MERGE reads
    "part or all of the existing table": the measurement above showed it can read one
    partition, so "the whole table" was not always true.
- **Pre-operations.** Incremental models often `DECLARE` a checkpoint in
  `pre_operations` and filter on it. A dry run of the query alone fails on the unknown
  name, and a dry run of pre-operations plus query counted 0 bytes for the filtered
  statement (measured 2026-11-20: 8.3 GB with a literal filter, 23.7 GB unfiltered). So a
  model whose query uses a declared variable is reported as not estimated, naming the
  variable (`core.preOpsVariableIn`), is never dry-run, and is left out of the "every
  dry run fails" count. The same goes for a query that reads a temp table its
  pre-operations create (`CREATE TEMP TABLE scope AS ...`, `core.preOpsTempTableIn`): it
  exists only inside Dataform's script, so the query alone fails on the unknown name.
  Pre-operations are part of the diff, so changing them alone counts as a change.
  **Script dry runs and temp tables (#119), measured 2026-11-23** on a 749 MB source
  partitioned by date, through real Dataform runs (CLI 3.1.6). A script dry run counts
  statements only up to the first `CREATE TEMP TABLE`: that statement and everything after it
  count 0, even a select that does not read the temp table. A temp table created with a
  column list instead of `AS SELECT` also gave 0 for a query that reads it. A select placed before it is counted in full. So
  a dry run of pre-operations plus query undercounts these models:
  - A table whose pre-operations create a temp table: the script dry run gave 0 bytes. The
    real run processed 196,929,431, which was 29,875,365 for the temp table plus 167,054,066
    for the query.
  - The same with a `DECLARE`d checkpoint: 0 for the full refresh, which processed
    1,067,347,121. The incremental script dry run gave 91,022,400, exactly a dry run of the
    `DECLARE`'s `MAX()` over the target alone. Two days of rows were then deleted from the
    target, and the real incremental run processed 241,456,014: the `DECLARE` (76,991,040,
    over the smaller target), the temp table (63,734,112) and the `INSERT` (100,730,862).

  The temp-table and query statements of the real runs matched, to the byte, dry runs of
  each alone: the temp table's select with the checkpoint as a literal, and the query with
  the temp table inlined as a subquery (or, for the table, with the join to it removed). The read of the temp table itself added nothing. That
  held where the temp table read the same table and partitions as the query; other shapes
  were not tried, and the estimate does not rewrite SQL. These models stay not estimated.

- **Just-in-time actions.** Dataform 3 can build an action's SQL when the workflow runs
  (`.jitCode()` in JavaScript, or `compilation_mode: "jit"` in SQLX). `dataform compile --json`
  then carries the code (`jitCode`) and no `query` or `queries`. Checked 2026-11-23: with CLI
  3.0.61 for a JavaScript table and operation; with 3.1.6 for those, plus an incremental, a
  view and a SQLX `compilation_mode: "jit"` table. The adapter used to stop
  the whole check on these ("has no query"), so one JIT action anywhere failed every pull
  request. Now each becomes a model with an empty query and `Model.jitCode`, and is reported
  as not estimated (`Estimate.jit`), never dry-run, and left out of the "every dry run fails"
  count. A table that becomes JIT is not shown as a saving. A JIT view is skipped like any
  view, but is never inlined into its readers, which keep reading the live view. The diff
  compares the code, so an edit counts as a change; the code is never rendered. Its rebuild
  counts as left out of the full refresh line.
- **New upstream tables.** A dry run fails when the SQL references a table the same PR
  creates. Report it plainly as not estimated; do not guess. When a head dry run fails and
  the query quotes the target of a model the PR adds (`core.readsNewTarget`), the reason
  names that table and says it can be estimated once the table exists. A read through a
  view the PR adds or changes is caught too, since that view is inlined first (see Views).
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
- **Comment size.** Editing `includes/` or `workflow_settings.yaml` can change every model
  at once, and a wall of rows buries the verdict. #25 assumed GitHub rejects comments over
  65,536 characters, but on 2026-11-20 both creating and updating a comment accepted
  162,087 characters, so the cap is kept for readability, not to avoid a rejection. The comment
  always starts with the headline and verdict and ends with the footer. Rows are sorted
  by the size of their monthly change (byte change breaks ties), and rows, notes and "not
  estimated" entries stop before 60,000 characters (`core.COMMENT_MAX_LENGTH`), ending with
  a count of the models left out. The job summary gets the same report capped at 900,000
  (GitHub documents a 1 MiB step summary limit; not verified), and the job log gets it uncapped. Chosen in #25.
- **Views.** Creating a view costs nothing; the cost lands on whatever reads it. Views are
  skipped with that reason, and the models that read a changed view are re-estimated
  (`core.withViewReaders`), even when their own SQL is unchanged, with a note naming the
  view. A dry run reads the view that is live in BigQuery, not the pull request's, so each
  side's view definition is inlined into the reader's query as a subquery
  (`core.inlineViews`): base with base, head with head, following unchanged views that read
  a changed one, and changed views that read each other. Chosen 2026-11-20, checked live: a view-only change that drops a filter
  showed its reader going from 51.71 MiB to 1.76 GiB per run.
- **Assertions, operations, pre/post operations.** Decide per type: estimate, skip, or
  label. Assertions are estimated like tables: each is a SELECT that scans its inputs on
  every run, so its bytes are a real, recurring spend. Custom operations and pre/post
  operations are skipped with a reason. Chosen 2026-11-20.
- **Regions.** On-demand price varies by location. The price is configurable first:
  `price_per_tib_by_location` overrides `price_per_tib` for a model whose location
  matches, without regard to case (`core.pricePerTibFor`), and the comment lists the
  overrides. A model with no location uses `price_per_tib`. Built-in prices: when the
  config sets no `price_per_tib`, each model is priced at Google's on-demand list price for
  its location (`core.ON_DEMAND_PRICE_PER_TIB`, 56 locations read from the Cloud Billing
  Catalog API on 2026-11-20; the footer names the prices used and their date). Order: the
  team's `price_per_tib_by_location`, then the list price, then `price_per_tib`. A price the
  team sets (a discount, or 0) always wins. Each model carries its BigQuery location.
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
  free tier. Checked 2026-11-20 on the sandbox (2 tables, 2 real runs each): the dry run
  matched the bytes the real job processed exactly. Billed bytes were 0.6 to 1.1% higher,
  because on-demand billing rounds each query up to the next MiB with a 10 MiB minimum, so
  for tiny queries the bill can exceed the estimate by that rounding (a fraction of a cent).
- **Partition filter detection.** A heuristic, surfaced as `Estimate.likelyCause` with the
  table name (`core.partitionFilterCause`). It fires when base and head both read the same
  partitioned table, and head reads at least 10 times as many bytes and at least 1 GiB more
  per run. The runner learns which tables are partitioned from the dry run's
  `referencedTables` and one `tables.get` per table (time or range partitioning). That
  lookup is extra detail: if it fails (no access, a wildcard table, rate limits), the
  table is left out and the estimate stands. A dry run over a view lists only the view,
  not the tables under it, so no cause is named there: by design, the check does not
  guess through views. A view the pull request changes is inlined (see Views), so a filter
  dropped inside it is named. Not detected: a filter that still exists but no longer prunes
  (for example, wrapped in a function).
