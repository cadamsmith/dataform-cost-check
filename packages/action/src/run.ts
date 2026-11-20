import {
  diffModels,
  estimateChanges,
  PARTITION_FILTER_REQUIRED_REASON,
  renderComment,
} from "@dataform-cost-check/core";
import type { Config, DryRunner, Model, Report } from "@dataform-cost-check/core";

export interface RunDeps {
  readonly config: Config;
  /** Compiled models at the base and head commits. */
  readonly loadModels: (side: "base" | "head") => Promise<Model[]>;
  readonly runner: DryRunner;
}

export interface RunResult {
  readonly report: Report;
  /** The PR comment, capped at `COMMENT_MAX_LENGTH`. */
  readonly comment: string;
  /** The job summary, capped at `SUMMARY_MAX_LENGTH`. */
  readonly summary: string;
  /** The whole report, uncapped, for the job log. */
  readonly full: string;
}

/** GitHub documents a 1 MiB step summary limit (not verified here); stay well below it. */
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
    (e) =>
      e.status !== "skipped" &&
      !(e.status === "unestimable" && (e.newUpstream !== undefined || dropsRequiredFilter(e))),
  );
  const failed = tried.filter((e) => e.status === "unestimable");
  const first = failed[0];
  if (first === undefined || failed.length < tried.length) return undefined;
  // Blame project setup only for failures that point at it. A query BigQuery rejects, or
  // a table it cannot find, is about the change itself.
  const setup =
    first.errorKind === undefined ||
    first.errorKind === "permission-denied" ||
    first.errorKind === "api-disabled" ||
    first.errorKind === "unknown";
  // The reason already points to the job log, so a rejected query needs no extra hint.
  const hint = setup ? "Check the Google Cloud project and permissions. " : "";
  return (
    `No changed model could be estimated (${String(failed.length)} tried). ${hint}` +
    `First error, for ${first.name}: ${first.reason}`
  );
}

/** A head dry run rejected for a missing required partition filter, where base passed. */
function dropsRequiredFilter(e: Report["estimates"][number]): boolean {
  return e.status === "unestimable" && e.reason.startsWith(PARTITION_FILTER_REQUIRED_REASON);
}

/**
 * Why the run should fail because the change would break in production: it leaves a
 * query without the partition filter its table requires. Undefined when none does.
 */
export function partitionFilterFailure(report: Report): string | undefined {
  const names = report.estimates.filter(dropsRequiredFilter).map((e) => e.name);
  if (names.length === 0) return undefined;
  return (
    `${names.join(", ")}: reads a table that requires a partition filter, and this change ` +
    "leaves the query without one, so it would fail when it runs."
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
