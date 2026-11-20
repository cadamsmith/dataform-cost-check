# Security

Dataform Cost Check runs inside your own GitHub Actions job, against your own Google Cloud
project. There is no service behind it: no server of ours, no account, no telemetry.

## What runs where

| Step                        | Where it runs                     | What it talks to                                                                                                                                                                   |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile base and head       | Your runner (Dataform CLI)        | The npm registry, only when `workflow_settings.yaml` sets `dataformCoreVersion`: the CLI downloads that `@dataform/core`. With a `package.json`, you install it in an earlier step |
| Estimate each changed model | Your runner                       | `bigquery.googleapis.com`, as your service account: free dry runs and `tables.get`                                                                                                 |
| Sign in to Google Cloud     | Your runner (Google auth library) | Google's token endpoints, using the credentials `google-github-actions/auth` set                                                                                                   |
| Post the comment            | Your runner                       | `api.github.com` (or your `GITHUB_API_URL`), with the job's `github-token`                                                                                                         |

Nothing else leaves your CI. The action sends compiled SQL only to BigQuery, in the project
you choose, and never runs a billable query. The pull request comment holds model names,
bytes and estimates, never query text: BigQuery's error messages, which can quote the
query, go to the job log only.

## Permissions it needs

- Google Cloud: BigQuery Job User on the dry-run project and BigQuery Data Viewer on the
  datasets your models read. No write access. See [README.md](README.md#permissions).
- GitHub: `contents: read`, `pull-requests: write` (for the comment) and `id-token: write`
  (for keyless sign-in). Run it on `pull_request`, never `pull_request_target`. Pull requests
  from forks get no report, because they get no secrets.

## Verifying what you run

- **Pin a full commit SHA**, not a tag: `uses: cadamsmith/dataform-cost-check@<40-character SHA> # v0.1.0`.
  Tags can move; a SHA cannot.
- **The bundled code matches the source.** `dist/index.cjs` is built from `packages/` with
  `pnpm build`, and CI fails any change where the committed `dist/` differs from a fresh build.
- **Build provenance.** Releases attest `dist/index.cjs` with GitHub artifact attestations
  once the repository is public. Check one with
  `gh attestation verify dist/index.cjs --repo cadamsmith/dataform-cost-check`.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this
repository. Do not open a public issue. You can expect a first reply within a week.
