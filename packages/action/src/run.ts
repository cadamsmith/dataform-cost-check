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
  /** The PR comment, capped below GitHub's comment size limit. */
  readonly comment: string;
  /** The job summary, capped below GitHub's step summary limit. */
  readonly summary: string;
  /** The whole report, uncapped, for the job log. */
  readonly full: string;
}

/** GitHub's step summary limit is 1 MiB; stay well below it. */
export const SUMMARY_MAX_LENGTH = 900_000;

/** The whole check, minus I/O: diff, estimate, render. */
export async function runCheck(deps: RunDeps): Promise<RunResult> {
  const [base, head] = await Promise.all([deps.loadModels("base"), deps.loadModels("head")]);
  const report = await estimateChanges(diffModels(base, head), deps.runner, deps.config);
  return {
    report,
    comment: renderComment(report),
    summary: renderComment(report, {
      maxLength: SUMMARY_MAX_LENGTH,
      fullReportAt: "The job log has the full report.",
    }),
    full: renderComment(report, { maxLength: Number.POSITIVE_INFINITY }),
  };
}

/**
 * Why the run as a whole should fail even though every model was "handled": every change
 * that needed a dry run came back unestimable. That usually means a misconfigured project
 * (no `bigquery.jobs.create`, the API disabled, a wrong project ID) rather than a problem
 * with the SQL, and passing green would hide it. Models that read a table the same pull
 * request creates are left out of the count: their failure is expected and explained.
 * Returns undefined when at least one dry run succeeded or none was needed.
 */
export function dryRunFailure(report: Report): string | undefined {
  const tried = report.estimates.filter(
    (e) => e.status !== "skipped" && !(e.status === "unestimable" && e.newUpstream !== undefined),
  );
  const failed = tried.filter((e) => e.status === "unestimable");
  const first = failed[0];
  if (first === undefined || failed.length < tried.length) return undefined;
  return (
    `No changed model could be estimated (${String(failed.length)} tried). ` +
    `Check the Google Cloud project and permissions. First error, for ${first.name}: ${first.reason}`
  );
}

/**
 * BigQuery's own messages, one `model: message` line per failed dry run, for the job log
 * only. They can quote the query, so they never go into the comment or the job summary.
 */
export function failureDetails(report: Report): string[] {
  return report.estimates.flatMap((e) =>
    e.status === "unestimable" && e.detail !== undefined ? [`${e.name}: ${e.detail}`] : [],
  );
}
