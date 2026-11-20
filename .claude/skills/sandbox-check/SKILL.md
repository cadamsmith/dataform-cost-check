---
name: sandbox-check
description: Prove a Dataform Cost Check release works inside GitHub Actions by pinning it in the private sandbox repo and re-running its demo PRs. Use after a release, before a demo, or when asked to check something end to end.
---

# Check a release in the sandbox

The sandbox repo, its Google Cloud project and its demo PRs are listed in the maintainer's
memory note `sandbox-setup`. Read it first; do not create new repos, service accounts or
datasets. If the note is missing, stop and ask.

1. **Pin.** In a local clone of the sandbox, on `main`: set the
   `uses: cadamsmith/dataform-cost-check@<sha> # vX.Y.Z` line in `.github/workflows/cost-check.yml`
   to the release's full commit SHA (`git rev-parse vX.Y.Z^{commit}` in this repo). Commit and push.
2. **Re-run** each open demo PR: merge `main` into its branch and push.
3. **Wait** for every run to finish (`gh run list --repo <sandbox>` until nothing is pending;
   use an until-loop, not chained sleeps).
4. **Read** each PR's sticky comment
   (`gh api repos/<sandbox>/issues/<n>/comments`, the body starting `<!-- dataform-cost-check`)
   and the run conclusion.
5. **Report** a table: PR, what it tests, expected, actual (headline, notes, check red or green).
   Flag anything unexpected. Over-limit and broken-filter PRs are meant to be red.

Dry runs are free. Running the sandbox's Dataform project for real is billed (cents) and
creates tables: ask first.
