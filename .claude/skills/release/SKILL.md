---
name: release
description: Cut a Dataform Cost Check release (vX.Y.Z) - bump versions, merge through CI, tag, and verify the release workflow. Use when the maintainer asks to release, tag, or ship a version.
---

# Release Dataform Cost Check

`main` is protected: every change merges through a PR whose `check` job passed.

1. **Pick the version.** Read the latest tag (`git tag --sort=-v:refname | head -1`). Since then:
   new user-facing behaviour → minor bump; fixes or docs only → patch. Say which and why.
2. **Bump** on a branch `release-X.Y.Z` from an up-to-date `main`: `pnpm release X.Y.Z`. It edits
   every version string (four `package.json`s, the log line in `packages/action/src/main.ts`,
   README, SECURITY.md), then runs `pnpm check` and `pnpm build`. Review the diff.
3. **PR.** Commit "Prepare X.Y.Z: <headline features>", push, open a PR that lists the PRs since
   the last tag, then `gh pr merge --auto --merge`. Confirm auto-merge is on
   (`gh pr view --json autoMergeRequest`). Wait until the PR is `MERGED`; never merge before
   checks have registered and passed.
4. **Tag** on the merged `main`: `git tag -a vX.Y.Z -m "Dataform Cost Check X.Y.Z (alpha)"` and
   `git push origin vX.Y.Z`.
5. **Verify** the `Release` workflow run: every step green, including "Attest build provenance",
   the GitHub release exists, and the major tag (`v0`) points at the new commit. Confirm the
   attestation: `gh attestation verify dist/index.cjs --repo cadamsmith/dataform-cost-check`
   on the tagged commit exits 0.
6. **Report** the release URL and the full commit SHA (`git rev-parse vX.Y.Z^{commit}`). That SHA
   is what users and the sandbox pin. Offer to run the `sandbox-check` skill against it.
7. **Marketplace (maintainer).** GitHub has no API for this, so releases the workflow creates
   are not published to the Marketplace listing. End the report by asking the maintainer to open
   `https://github.com/cadamsmith/dataform-cost-check/releases/edit/vX.Y.Z`, tick "Publish this
   Action to the GitHub Marketplace", keep the label on **Latest**, and click Update release.
   Skipping it only leaves the listing's shown version behind; SHA and `@v0` users are
   unaffected. If the listing at https://github.com/marketplace/actions/dataform-cost-check
   already shows the new version without this, remove this step.
