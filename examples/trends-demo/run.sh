#!/usr/bin/env bash
# Run Dataform Cost Check locally on a two-commit demo project that reads a public,
# day-partitioned BigQuery table (google_trends.top_terms). The head commit drops the
# filter on its partition column, so the comment names the likely cause. Dry runs are free.
#
# Needs: the Dataform CLI (npm install -g @dataform/cli), Application Default
# Credentials (gcloud auth application-default login), and a built dist/ (pnpm build).
#
# Usage: examples/trends-demo/run.sh [--project ID] [--limit USD] [--pr NUMBER]
#   --project  Google Cloud project to run dry runs in (default: gcloud's current project)
#   --limit    limit_monthly for this run (default: 100)
#   --pr       also post (or update) the sticky comment on this pull request of the
#              repository this script lives in, using your gh CLI login
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
project="$(gcloud config get-value project 2>/dev/null || true)"
limit=100
pr=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --pr) pr="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$project" ]]; then
  echo "No Google Cloud project: pass --project ID or run gcloud config set project ID." >&2
  exit 2
fi

demo="$(mktemp -d)/trends-demo"
mkdir -p "$demo/definitions/sources"
cd "$demo"
git init -q -b main

cat > workflow_settings.yaml <<'YAML'
defaultProject: demo-project
defaultLocation: US
defaultDataset: cost_check_demo
defaultAssertionDataset: cost_check_demo_assertions
dataformCoreVersion: 3.0.0
YAML

cat > definitions/sources/top_terms.sqlx <<'SQLX'
config {
  type: "declaration",
  database: "bigquery-public-data",
  schema: "google_trends",
  name: "top_terms"
}
SQLX

cat > definitions/trending_terms.sqlx <<'SQLX'
config { type: "table", tags: ["hourly"] }

SELECT dma_name, term, rank
FROM ${ref("top_terms")}
WHERE refresh_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
SQLX

cat > dataform-cost-check.yml <<YAML
price_per_tib: 6.25
limit_monthly: $limit
default_runs_per_day: 1
runs_per_day:
  hourly: 24
YAML

git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "Trending terms, yesterday only"
sed -i.bak '/^WHERE refresh_date/d' definitions/trending_terms.sqlx
rm definitions/trending_terms.sqlx.bak
git -c user.name=demo -c user.email=demo@example.com commit -qam "Drop the date filter"

echo "== The pull request: one line removed"
git --no-pager diff HEAD~1 -- definitions
echo
echo "== Dataform Cost Check"
: > outputs.txt
: > summary.md
pr_env=()
if [[ -n "$pr" ]]; then
  repo="$(cd "$repo_root" && gh repo view --json nameWithOwner -q .nameWithOwner)"
  cat > event.json <<JSON
{"pull_request": {"number": $pr, "base": {"repo": {"full_name": "$repo"}}, "head": {"repo": {"full_name": "$repo"}}}}
JSON
  pr_env=(GITHUB_EVENT_PATH="$demo/event.json" "INPUT_GITHUB-TOKEN=$(gh auth token)")
fi
status=0
env ${pr_env[@]+"${pr_env[@]}"} "INPUT_BASE-REF=$(git rev-parse HEAD~1)" "INPUT_PROJECT-ID=$project" \
  GITHUB_OUTPUT="$demo/outputs.txt" GITHUB_STEP_SUMMARY="$demo/summary.md" \
  node "$repo_root/dist/index.cjs" || status=$?
echo
echo "== Check exit code: $status (non-zero fails the pull request)"
