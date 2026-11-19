# Driftline Check

> **Status: pre-alpha.** The repository is scaffolded and the pricing and comment logic
> is tested. The action does not yet compile Dataform projects or call BigQuery, so it
> reports "no models changed" on every run. Do not install it on real projects yet.

A GitHub Action that posts a BigQuery cost estimate on every pull request in a
[Dataform](https://cloud.google.com/dataform) project: a price tag on every data change,
before it ships rather than on next month's bill.

When a pull request opens, the action compiles the Dataform project at the base and head
commits, finds the models whose compiled SQL changed, asks BigQuery for a free dry-run byte
count for each, and posts one sticky comment such as:

> This change adds an estimated **+$225.00 / month**. :x: Over the $100.00 limit.
>
> | Model          | Change   | Scanned per run (before → after) | Runs / day | Monthly estimate |
> | -------------- | -------- | -------------------------------- | ---------: | ---------------: |
> | `orders_daily` | modified | 40.96 GiB → 1.24 TiB             |          1 |         +$225.00 |
>
> - `orders_daily`: likely cause: the partition filter was removed.

## Who it is for

Teams on BigQuery who manage transformations with Dataform and review changes on GitHub.
dbt users already have cost checks; Dataform has had no packaged pull request check.

## Planned features (v1)

- Sticky pull request comment with the total monthly estimate change
- Bytes scanned before and after, per changed model
- Flags the most common cause of a jump: a lost partition filter
- One configurable spending limit that can fail the check
- Last refresh duration per table, shown as history when permissions allow

It runs in your own CI against your own Google Cloud project. Nothing is sent to a
third-party service, and no one else holds your credentials.

## Usage (once released)

```yaml
# .github/workflows/driftline.yml
on: pull_request # never pull_request_target

jobs:
  estimate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write # keyless auth to Google Cloud
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      # Authenticate to Google Cloud here (Workload Identity Federation).
      - uses: cadamsmith/dataform-cost-check@v1
        with:
          config-path: driftline.yml
```

| Input          | Default                     | Description                           |
| -------------- | --------------------------- | ------------------------------------- |
| `config-path`  | `driftline.yml`             | Path to the config file               |
| `base-ref`     | the pull request's base SHA | Commit to compare against             |
| `github-token` | `${{ github.token }}`       | Token used to post the sticky comment |

Configuration, in `driftline.yml` (see [`driftline.example.yml`](driftline.example.yml)):

```yaml
price_per_tib: 6.25 # USD, on-demand
limit_monthly: 100 # fail the check above this
default_runs_per_day: 1
runs_per_day: # overrides by Dataform tag or model name
  hourly: 24
```

## Limits to know

Figures are **estimates and upper bounds**: they come from dry runs, ignore caching, and do
not deduct BigQuery's monthly free tier. They assume on-demand pricing. If your project uses
slot-based (Editions) pricing, bytes scanned do not map to dollars. The action never predicts
run time. See [docs/design.md](docs/design.md) for how each case is handled.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design notes are in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
