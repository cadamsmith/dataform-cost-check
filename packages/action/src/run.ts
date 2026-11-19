import { diffModels, estimateChanges, renderComment } from "@dataform-cost-check/core";
import type { Config, DryRunner, Model, Report } from "@dataform-cost-check/core";

export interface RunDeps {
  readonly config: Config;
  /** Compiled models at the base and head commits. */
  readonly loadModels: (side: "base" | "head") => Promise<Model[]>;
  readonly runner: DryRunner;
}

export interface RunResult {
  readonly report: Report;
  readonly comment: string;
}

/** The whole check, minus I/O: diff, estimate, render. */
export async function runCheck(deps: RunDeps): Promise<RunResult> {
  const [base, head] = await Promise.all([deps.loadModels("base"), deps.loadModels("head")]);
  const report = await estimateChanges(diffModels(base, head), deps.runner, deps.config);
  return { report, comment: renderComment(report) };
}

/**
 * Why the run as a whole should fail even though every model was "handled": every change
 * that needed a dry run came back unestimable. That usually means a misconfigured project
 * (no `bigquery.jobs.create`, the API disabled, a wrong project ID) rather than a problem
 * with the SQL, and passing green would hide it. Returns undefined when at least one dry
 * run succeeded or none was needed.
 */
export function dryRunFailure(report: Report): string | undefined {
  const tried = report.estimates.filter((e) => e.status !== "skipped");
  const failed = tried.filter((e) => e.status === "unestimable");
  const first = failed[0];
  if (first === undefined || failed.length < tried.length) return undefined;
  return (
    `No changed model could be estimated (${String(failed.length)} tried). ` +
    `Check the Google Cloud project and permissions. First error, for ${first.name}: ${first.reason}`
  );
}
