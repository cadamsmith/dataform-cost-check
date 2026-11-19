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

### Paid tier, working name "Driftline Team" (not in this repository; do not build here)

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
  full-refresh estimate separately.
- **New upstream tables.** A dry run fails when the SQL references a table the same PR
  creates. Report it plainly as not estimated; do not guess.
- **Views.** Creating a view costs nothing; the cost lands on whatever reads it. Views are
  skipped with that reason.
- **Assertions, operations, pre/post operations.** Decide per type: estimate, skip, or
  label. v1 skips assertions and operations with a reason.
- **Regions.** On-demand price varies by location. The price is configurable first;
  region-aware pricing comes later. Each model carries its BigQuery location.
- **Slot-based pricing.** Bytes do not map to dollars. The comment says so.
- **Estimate is an upper bound.** Say "estimate", never "cost". Do not deduct the monthly
  free tier.
- **Partition filter detection.** Start with a simple heuristic (a large byte jump on a
  partitioned table); refine later. Surfaced as `Estimate.likelyCause`.
