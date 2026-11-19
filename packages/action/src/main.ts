import { existsSync, readFileSync } from "node:fs";
import * as core from "@actions/core";
import { DEFAULT_CONFIG, FakeDryRunner } from "@dataform-cost-check/core";
import { parseConfig } from "./config.ts";
import { runCheck } from "./run.ts";

/**
 * Action entry point. Scaffold only: it wires a fake DryRunner and empty compilations,
 * and writes the comment to the job summary instead of posting it.
 *
 * TODO(milestone 1):
 * - check out base-ref and head, and load models with @dataform-cost-check/dataform
 * - swap FakeDryRunner for BigQueryDryRunner
 * - post or update the sticky comment with github-token (skip quietly on fork PRs,
 *   where secrets are unavailable)
 */
async function main(): Promise<void> {
  const configPath = core.getInput("config-path") || "dataform-cost-check.yml";
  const baseRef = core.getInput("base-ref");
  core.info(`Dataform Cost Check (pre-alpha). Base ref: ${baseRef || "(pull request base)"}`);

  const config = existsSync(configPath)
    ? parseConfig(readFileSync(configPath, "utf8"))
    : DEFAULT_CONFIG;
  if (!existsSync(configPath)) core.info(`No ${configPath} found; using defaults.`);

  const { report, comment } = await runCheck({
    config,
    loadModels: () => Promise.resolve([]),
    runner: new FakeDryRunner(),
  });

  await core.summary.addRaw(comment).write();
  core.setOutput("monthly-delta", report.totalMonthlyDelta.toFixed(2));
  core.setOutput("over-limit", String(report.overLimit));

  if (report.overLimit) {
    core.setFailed("Estimated monthly spend change is over the configured limit.");
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
