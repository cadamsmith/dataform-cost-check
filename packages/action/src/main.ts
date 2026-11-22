import { join, resolve } from "node:path";
import * as core from "@actions/core";
import {
  applicationDefaultToken,
  BigQueryDryRunner,
  readRefreshHistory,
} from "@dataform-cost-check/bigquery";
import { commentMarker, limitCannotApply, limitConcurrency } from "@dataform-cost-check/core";
import type { Model } from "@dataform-cost-check/core";
import { loadModels } from "@dataform-cost-check/dataform";
import { copyDependencies, resolveBaseRef, withBaseWorktree } from "./base-checkout.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { readPullRequestContext, upsertStickyComment } from "./pr-comment.ts";
import { dryRunFailure, failureDetails, partitionFilterFailure, runCheck } from "./run.ts";

/** Dry runs in flight at once, to stay under BigQuery's rate limits on large PRs. */
const MAX_CONCURRENT_DRY_RUNS = 4;

/**
 * Action entry point: compile the Dataform project at base and head, dry-run the changed
 * models in the user's own BigQuery project, and report the estimate in the job summary
 * and as a sticky pull request comment.
 */
async function main(): Promise<void> {
  // Fork pull requests get no secrets and a read-only token. Report nothing and pass,
  // before anything that needs Google Cloud credentials can fail.
  const pr = await readPullRequestContext(process.env.GITHUB_EVENT_PATH);
  if (pr?.isFork) {
    const note =
      "Dataform Cost Check: no report for pull requests from forks, which get no secrets.";
    core.notice(note);
    await core.summary.addRaw(note).write();
    return;
  }

  const configPath = core.getInput("config-path") || DEFAULT_CONFIG_PATH;
  const projectDir = core.getInput("project-dir") || ".";
  const projectId =
    core.getInput("project-id") ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.CLOUDSDK_CORE_PROJECT;
  if (!projectId) {
    throw new Error(
      "No Google Cloud project for dry runs: set the project-id input, or authenticate with google-github-actions/auth.",
    );
  }
  const baseRef = await resolveBaseRef(core.getInput("base-ref"), process.env.GITHUB_EVENT_PATH);
  core.info(`Dataform Cost Check 0.4.3 (alpha). Base: ${baseRef}. Dry runs in: ${projectId}.`);

  const { config, found: configFound } = loadConfig(configPath);
  if (!configFound) {
    // A notice shows in the run summary; a warning would also show on the pull request.
    core.notice(
      `No ${configPath} found, so every model is assumed to run once a day and no limit applies.`,
    );
  }

  const overrides = {
    defaultDatabase: core.getInput("default-database"),
    defaultSchema: core.getInput("default-schema"),
    defaultLocation: core.getInput("default-location"),
    schemaSuffix: core.getInput("schema-suffix"),
    tablePrefix: core.getInput("table-prefix"),
    vars: core.getInput("vars"),
  };
  const repoDir = process.cwd();
  const load = (side: "base" | "head"): Promise<Model[]> =>
    side === "head"
      ? loadModels({ projectDir: resolve(repoDir, projectDir), overrides })
      : withBaseWorktree(repoDir, baseRef, async (dir) => {
          const baseProject = join(dir, projectDir);
          // The base checkout is a fresh directory. Reuse the dependencies installed at
          // head rather than downloading them again.
          await copyDependencies(resolve(repoDir, projectDir), baseProject);
          return loadModels({ projectDir: baseProject, overrides });
        });

  const { report, comment, summary, full } = await runCheck({
    config,
    loadModels: load,
    projectDir,
    configPath,
    configFound,
    runner: limitConcurrency(new BigQueryDryRunner({ projectId }), MAX_CONCURRENT_DRY_RUNS),
    // Opt-in (`history: true`): job records of the dry-run project, where Dataform runs.
    readHistory: (targets) =>
      readRefreshHistory(targets, { projectId, getAccessToken: applicationDefaultToken() }),
  });
  if (report.history?.status === "unavailable") {
    core.warning(`Refresh history is turned on, but ${report.history.reason}.`);
  }

  core.info(full);
  // Plain log lines, not warnings: annotations show up on the pull request.
  const details = failureDetails(report);
  if (details.length > 0) {
    core.info(["BigQuery's messages for the dry runs that failed:", ...details].join("\n"));
  }
  await core.summary.addRaw(summary).write();
  core.setOutput("monthly-delta", report.totalMonthlyDelta.toFixed(2));
  core.setOutput("over-limit", String(report.overLimit));
  // With no changed models, only keep an earlier comment current: don't start a new one.
  await postComment(pr, comment, projectDir, report.estimates.length === 0);

  if (limitCannotApply(report)) {
    core.warning(
      "limit_monthly is set, but every estimated model is priced at 0 per TiB, so the limit cannot apply.",
    );
  }

  const failure = partitionFilterFailure(report) ?? dryRunFailure(report);
  if (failure !== undefined) {
    core.setFailed(failure);
  } else if (report.overLimit) {
    core.setFailed("Estimated monthly spend change is over the configured limit.");
  }
}

/** Posts or updates the sticky comment. Never fails the check: the summary has the report. */
async function postComment(
  pr: Awaited<ReturnType<typeof readPullRequestContext>>,
  body: string,
  projectDir: string,
  updateOnly: boolean,
): Promise<void> {
  const token = core.getInput("github-token");
  if (pr === undefined || !token) {
    core.info("Not a pull request run, or no github-token: report is in the job summary only.");
    return;
  }
  try {
    const result = await upsertStickyComment({
      token,
      pr,
      body,
      marker: commentMarker(projectDir),
      updateOnly,
      apiUrl: process.env.GITHUB_API_URL,
    });
    core.info(
      result.action === "skipped"
        ? "No models changed and no earlier comment to update, so no comment was posted."
        : `Comment ${result.action}: ${result.url}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(
      `Could not post the pull request comment (does the job have pull-requests: write?). ${detail}`,
    );
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
