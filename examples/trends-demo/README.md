# Google Trends demo

A local run of the check on a two-commit Dataform project. It reads the public table
`bigquery-public-data.google_trends.top_terms`, which is partitioned by day on
`refresh_date`, and the second commit deletes the `WHERE` line that limits the scan to
yesterday. The comment names the likely cause: a filter on that partitioned table was
removed.

```sh
pnpm build
examples/trends-demo/run.sh               # about +$7.50 / month, within the $100 limit, with a likely cause
examples/trends-demo/run.sh --limit 5     # same estimate, over the limit: fails
examples/trends-demo/run.sh --pr 16       # also posts the sticky comment on PR #16; rerun edits it
```

Needs the same setup as [the bitcoin demo](../bitcoin-demo/README.md): the Dataform CLI and
Application Default Credentials. Dry runs and table metadata lookups are free.
