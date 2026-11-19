import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as core from "@actions/core";
import { BigQueryDryRunner } from "@dataform-cost-check/bigquery";
import { DEFAULT_CONFIG, limitConcurrency } from "@dataform-cost-check/core";
import type { Model } from "@dataform-cost-check/core";
import { loadModels } from "@dataform-cost-check/dataform";
import { resolveBaseRef, withBaseWorktree } from "./base-checkout.ts";
import { parseConfig } from "./config.ts";
import { dryRunFailure, runCheck } from "./run.ts";

/** Dry runs in flight at once, to stay under BigQuery's rate limits on large PRs. */
const MAX_CONCURRENT_DRY_RUNS = 4;

/**
 * Action entry point: compile the Dataform project at base and head, dry-run the changed
 * models in the user's own BigQuery project, and report the estimate.
 *
 * TODO(milestone 1): post or update the sticky comment with github-token (skip quietly on
 * fork PRs, where secrets are unavailable). For now the comment goes to the job summary.
 */
async function main(): Promise<void> {
  const configPath = core.getInput("config-path") || "dataform-cost-check.yml";
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
  core.info(`Dataform Cost Check (pre-alpha). Base: ${baseRef}. Dry runs in: ${projectId}.`);

  const config = existsSync(configPath)
    ? parseConfig(readFileSync(configPath, "utf8"))
    : DEFAULT_CONFIG;
  if (!existsSync(configPath)) core.info(`No ${configPath} found; using defaults.`);

  const repoDir = process.cwd();
  const load = (side: "base" | "head"): Promise<Model[]> =>
    side === "head"
      ? loadModels({ projectDir: resolve(repoDir, projectDir) })
      : withBaseWorktree(repoDir, baseRef, (dir) =>
          loadModels({ projectDir: join(dir, projectDir) }),
        );

  const { report, comment } = await runCheck({
    config,
    loadModels: load,
    runner: limitConcurrency(new BigQueryDryRunner({ projectId }), MAX_CONCURRENT_DRY_RUNS),
  });

  core.info(comment);
  await core.summary.addRaw(comment).write();
  core.setOutput("monthly-delta", report.totalMonthlyDelta.toFixed(2));
  core.setOutput("over-limit", String(report.overLimit));

  const failure = dryRunFailure(report);
  if (failure !== undefined) {
    core.setFailed(failure);
  } else if (report.overLimit) {
    core.setFailed("Estimated monthly spend change is over the configured limit.");
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
