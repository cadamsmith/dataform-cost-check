# Try it on your project

This guide takes a Dataform repository on GitHub from nothing to its first estimate comment.
It takes about 15 minutes, most of it in Google Cloud. These are the steps we ran end to end
on 2026-11-20, inside GitHub Actions, against a Dataform 3 test project shaped like a real
team's: JavaScript-defined actions, a `package.json`, incremental models with pre-operations,
and a view. For Dataform 2, the compile step is tested every night, but not yet a full run.

The check is read-only and free to run. It asks BigQuery for dry runs, which plan a query and
report the bytes it would scan without reading data or billing anything. Nothing goes anywhere
except your Google Cloud project and GitHub. See [SECURITY.md](../SECURITY.md).

## What you need

- A GitHub repository with a Dataform project (Dataform 3, or Dataform 2 with `dataform.json`).
- The Google Cloud project where your BigQuery data lives. Below it's called `PROJECT_ID`.
- Permission in that project to create a service account and a Workload Identity pool (for
  example Owner, or IAM Admin plus Workload Identity Pool Admin), and the `gcloud` CLI.

## 1. A service account with read-only BigQuery access

```sh
PROJECT_ID=my-project                       # your Google Cloud project
REPO=my-org/my-dataform-repo                # your GitHub repository, owner/name
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA=dataform-cost-check@$PROJECT_ID.iam.gserviceaccount.com

gcloud services enable bigquery.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts create dataform-cost-check --project="$PROJECT_ID" \
  --display-name="Dataform Cost Check (read-only dry runs)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/bigquery.jobUser
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/bigquery.dataViewer
```

Both roles are needed: Job User to start dry runs, Data Viewer because BigQuery checks read
access on every table a dry run references. Tested: with Job User alone, or Job User plus
Metadata Viewer, dry runs are denied. You can grant Data Viewer on just the datasets your
models read instead of the whole project. If models read tables in other projects, grant Data
Viewer there too.

## 2. Keyless sign-in from GitHub (no keys to leak)

```sh
gcloud iam workload-identity-pools create github --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc dataform-cost-check --project="$PROJECT_ID" \
  --location=global --workload-identity-pool=github --display-name="Dataform Cost Check" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

echo "workload_identity_provider: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/dataform-cost-check"
echo "service_account: $SA"
```

The attribute condition means only workflows in your repository can use this sign-in. Keep
the two printed lines for the next step.

## 3. The workflow

Add `.github/workflows/cost-check.yml`, filling in the two lines from step 2:

```yaml
name: Cost check
on: pull_request # never pull_request_target

# A newer push cancels the run still going for the old one, so it can't overwrite the newer
# estimate. Dry runs are free, so nothing is lost.
concurrency:
  group: dataform-cost-check-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  estimate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # to post the comment
      id-token: write # keyless sign-in to Google Cloud
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the check compiles the base commit too
      - uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/dataform-cost-check
          service_account: dataform-cost-check@PROJECT_ID.iam.gserviceaccount.com
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      # Match your project's Dataform version: the 3.x CLI needs a @dataform/core with the
      # same major.minor (for example cli 3.0.61 with core 3.0.x). Dataform 2: @dataform/cli@2.9.0.
      - run: npm install -g @dataform/cli@3.0.61
      # Only if your project has a package.json that pins @dataform/core:
      - run: npm ci
      # Pin a release's full commit SHA (see the release page), not a tag.
      - uses: cadamsmith/dataform-cost-check@be9440a0111cea988496103498d6cd68f739b949 # v0.4.2
```

If the Dataform project is not at the repository root, add `project-dir: path/to/project` under
the action's `with:`. A repository with several Dataform projects runs one job per directory,
and each keeps its own comment. If those jobs set their own `concurrency` group, or live in
separate workflows, put the directory in the group name, for example
`dataform-cost-check-${{ github.event.pull_request.number }}-path/to/project`, or they cancel
each other.

**If production runs from a release config** with overrides (another Google Cloud project, a
schema suffix, compilation variables), pass the same values so the check compiles what
production runs:

```yaml
- uses: cadamsmith/dataform-cost-check@be9440a0111cea988496103498d6cd68f739b949 # v0.4.2
  with:
    default-database: my-prod-project
    schema-suffix: ""
    vars: env=prod
```

## 4. The config

Add `dataform-cost-check.yml` at the repository root. Every key is optional:

```yaml
limit_monthly: 100 # fail the check when a change adds more than this many USD a month
default_runs_per_day: 1 # weekly: 0.142857 (1/7); the comment shows "1 / week"
runs_per_day: # overrides by model name, or by a tag your schedules select on
  hourly: 24
# price_per_tib: 6.25 # one price everywhere (a discount, or 0 for flat-rate plans).
#                     # Default: Google's list price for each model's location.
# history: true       # show each changed model's last run; needs BigQuery Resource Viewer
```

Runs per day come from this file, not from your Dataform schedules. Set them to match your
workflow configs, or the monthly figures are off by the same factor. If every model runs on
one schedule, `default_runs_per_day` alone is enough. A tag is only worth listing when your
workflow configs pick models by that tag; a tag by itself changes nothing about when a
model runs. A model name always works. Without the file, every
model is assumed to run once a day, no limit applies, and the comment says so.

## 5. Your first comment

Open a pull request that changes a model. For a clear first result, remove a date filter on a
partitioned table in a copy of a model. Within a minute or two the job posts one comment and
updates it on every push:

- a headline: the estimated monthly change, and whether it is within your limit;
- when incremental models change, a **Full refresh** line: one rebuild of the changed models
  from scratch, before and after, kept out of the monthly figure;
- a table of changed models, with bytes scanned per run before and after;
- notes: a removed partition filter named as the likely cause, a changed view's readers
  re-estimated, merge-style models flagged as lower bounds;
- **Not estimated**, with a plain reason for anything it can't price (for example, a query
  that filters on a variable set in `pre_operations`).

The check fails (red) when the estimate goes over `limit_monthly`, when a change drops a
partition filter that a table requires, or when no changed model could be estimated at all.

## Troubleshooting

| Message (in the job log or comment)                                                                                | What to do                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `No Google Cloud project for dry runs: set the project-id input, or authenticate with google-github-actions/auth.` | The auth step is missing or ran after the action. Put it before, or set `project-id`.                    |
| `Could not check out base commit … set fetch-depth: 0.`                                                            | Add `fetch-depth: 0` to `actions/checkout`.                                                              |
| `Dataform CLI not found: dataform.`                                                                                | Add the `npm install -g @dataform/cli@…` step.                                                           |
| `… has a package.json but no node_modules. Run npm ci …`                                                           | Add the `npm ci` step (or `dataform install`) before the action.                                         |
| `… is not compatible with @dataform/cli …`                                                                         | The CLI and your `@dataform/core` must share major.minor. Change the CLI version in the workflow.        |
| A model `not estimated`: _permission denied_                                                                       | Grant Data Viewer on the dataset it reads (step 1). BigQuery's full message is in the job log.           |
| `No changed model could be estimated (N tried). Check the Google Cloud project and permissions.`                   | Every dry run failed: usually a missing role, the BigQuery API turned off, or the wrong project.         |
| `Could not post the pull request comment (does the job have pull-requests: write?)`                                | Add `pull-requests: write` to the job's permissions. The report is still in the job summary.             |
| `no report for pull requests from forks`                                                                           | Expected: forks get no secrets or sign-in, so the check skips them and passes.                           |
| Dry runs fail only from GitHub, with a VPC Service Controls message                                                | Allow the service account through the perimeter, or use a self-hosted runner inside it (see the README). |
| `Refresh history is turned on, but the service account cannot list job history …`                                  | Grant BigQuery Resource Viewer, or set `history: false`.                                                 |
| `No dataform-cost-check.yml found, so every model is assumed to run once a day …`                                  | Add the file at the repository root, not under `project-dir`.                                            |
| `config-path is set to …, but there is no such file`                                                               | Fix the path: it is relative to the repository root.                                                     |

## Removing it

Delete the workflow file and the config. In Google Cloud, delete the `dataform-cost-check`
service account and the `github` Workload Identity pool. Nothing else was created.
