import { exceedsLimit, monthlyDelta, runsPerDayFor } from "./pricing.ts";
import type { Config, DryRunner, Estimate, Model, ModelChange, Report } from "./types.ts";

/** Why some model types are not estimated. See docs/design.md, "Hard cases". */
const SKIP_REASONS: Partial<Record<Model["type"], string>> = {
  view: "Views cost nothing to create; the cost lands on whatever reads them.",
  assertion: "Assertions are not estimated yet.",
  operations: "Custom operations are not estimated yet.",
};

/**
 * The SQL that represents a model's steady-state cost. Incremental models use the
 * incremental query; everything else uses the main query.
 *
 * TODO(milestone 2): also estimate the full-refresh query of incremental models and
 * report it separately.
 */
export function steadyStateSql(model: Model): string {
  return model.incrementalQuery ?? model.query;
}

function estimable(model: Model): Model | undefined {
  return SKIP_REASONS[model.type] === undefined ? model : undefined;
}

/** Dry-run both sides of one change and price the difference. */
export async function estimateChange(
  change: ModelChange,
  runner: DryRunner,
  config: Config,
): Promise<Estimate> {
  const model = change.kind === "removed" ? change.base : change.head;
  const common = { target: change.target, name: model.name, kind: change.kind, type: model.type };

  // A side that does not exist, or whose type is not estimated (e.g. a view), scans
  // nothing at run time. Skip only when neither side is estimable, so a table turning
  // into a view still shows the saving.
  const base = change.kind === "added" ? undefined : estimable(change.base);
  const head = change.kind === "removed" ? undefined : estimable(change.head);
  if (base === undefined && head === undefined) {
    return { status: "skipped", ...common, reason: SKIP_REASONS[model.type] ?? "Not estimated." };
  }

  const [baseResult, headResult] = await Promise.all([
    base === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(base), base.location),
    head === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(head), head.location),
  ]);

  if ("error" in baseResult) {
    return {
      status: "unestimable",
      ...common,
      reason: `Dry run at base failed: ${baseResult.error}`,
    };
  }
  if ("error" in headResult) {
    return {
      status: "unestimable",
      ...common,
      reason: `Dry run at head failed: ${headResult.error}`,
    };
  }

  const runsPerDay = runsPerDayFor(model, config);
  return {
    status: "estimated",
    ...common,
    baseBytes: baseResult.bytes,
    headBytes: headResult.bytes,
    runsPerDay,
    monthlyDelta: monthlyDelta(baseResult.bytes, headResult.bytes, config.pricePerTib, runsPerDay),
    // TODO(milestone 2): set likelyCause via the partition-filter heuristic.
  };
}

/** Estimate every change and assemble the report. */
export async function estimateChanges(
  changes: readonly ModelChange[],
  runner: DryRunner,
  config: Config,
): Promise<Report> {
  const estimates = await Promise.all(changes.map((c) => estimateChange(c, runner, config)));
  return buildReport(estimates, config);
}

/** Total the estimates and apply the limit. Pure. */
export function buildReport(estimates: readonly Estimate[], config: Config): Report {
  const totalMonthlyDelta = estimates.reduce(
    (sum, e) => (e.status === "estimated" ? sum + e.monthlyDelta : sum),
    0,
  );
  return {
    estimates,
    totalMonthlyDelta,
    pricePerTib: config.pricePerTib,
    limitMonthly: config.limitMonthly,
    overLimit: exceedsLimit(totalMonthlyDelta, config.limitMonthly),
  };
}
