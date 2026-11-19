import { exceedsLimit, monthlyDelta, pricePerTibFor, runsPerDayFor } from "./pricing.ts";
import type {
  Config,
  DryRunResult,
  DryRunner,
  Estimate,
  LikelyCause,
  Model,
  ModelChange,
  Report,
} from "./types.ts";

/** How many times more a run must read before a lost partition filter is suspected. */
export const PARTITION_JUMP_RATIO = 10;
/** And by how much, per run, so small tables jumping from 1 MiB to 20 MiB are not flagged. */
export const PARTITION_JUMP_MIN_BYTES = 2 ** 30;

type DryRunBytes = Extract<DryRunResult, { bytes: number }>;

/**
 * The partition-filter heuristic (docs/design.md, "Partition filter detection"): both
 * sides read the same partitioned table, and head reads at least `PARTITION_JUMP_RATIO`
 * times as much, and at least `PARTITION_JUMP_MIN_BYTES` more. Pure.
 */
export function partitionFilterCause(
  base: DryRunBytes,
  head: DryRunBytes,
): LikelyCause | undefined {
  if (base.bytes <= 0) return undefined;
  if (head.bytes < base.bytes * PARTITION_JUMP_RATIO) return undefined;
  if (head.bytes - base.bytes < PARTITION_JUMP_MIN_BYTES) return undefined;
  const baseTables = new Set(base.partitionedTables ?? []);
  const table = (head.partitionedTables ?? []).find((t) => baseTables.has(t));
  return table === undefined ? undefined : { kind: "partition-filter-removed", table };
}

/** Why some model types are not estimated. See docs/design.md, "Hard cases". */
const SKIP_REASONS: Partial<Record<Model["type"], string>> = {
  view: "Views cost nothing to create; the cost lands on whatever reads them.",
  assertion: "Assertions are not estimated yet.",
  operations: "Custom operations are not estimated yet.",
};

/**
 * The SQL that represents a model's steady-state cost. Incremental models use the
 * incremental query; everything else uses the main query. The full-refresh query of an
 * incremental model is estimated separately (`Estimate.fullRefreshBytes`).
 */
export function steadyStateSql(model: Model): string {
  return model.incrementalQuery ?? model.query;
}

function estimable(model: Model): Model | undefined {
  return SKIP_REASONS[model.type] === undefined ? model : undefined;
}

/**
 * The first target in `newTargets` that `sql` reads, other than the model's own. Compiled
 * Dataform SQL quotes every reference as `` `project.dataset.table` ``.
 */
export function readsNewTarget(
  sql: string,
  ownTarget: string,
  newTargets: ReadonlySet<string>,
): string | undefined {
  for (const t of newTargets) if (t !== ownTarget && sql.includes(`\`${t}\``)) return t;
  return undefined;
}

/**
 * Dry-run both sides of one change and price the difference. `newTargets` holds the
 * targets this pull request adds: a head query that reads one fails its dry run because
 * the table does not exist yet, and is reported as such.
 */
export async function estimateChange(
  change: ModelChange,
  runner: DryRunner,
  config: Config,
  newTargets: ReadonlySet<string> = new Set(),
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

  const [baseResult, headResult, fullRefreshResult] = await Promise.all([
    base === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(base), base.location),
    head === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(head), head.location),
    head?.incrementalQuery === undefined ? undefined : runner.estimate(head.query, head.location),
  ]);

  if ("error" in baseResult) {
    return {
      status: "unestimable",
      ...common,
      reason: `Dry run at base failed: ${baseResult.error}`,
    };
  }
  if ("error" in headResult) {
    const upstream =
      head === undefined
        ? undefined
        : readsNewTarget(steadyStateSql(head), change.target, newTargets);
    if (upstream !== undefined) {
      return {
        status: "unestimable",
        ...common,
        reason: `Reads \`${upstream}\`, which this pull request creates, so it can only be estimated once that table exists.`,
        newUpstream: upstream,
      };
    }
    return {
      status: "unestimable",
      ...common,
      reason: `Dry run at head failed: ${headResult.error}`,
    };
  }

  const runsPerDay = runsPerDayFor(model, config);
  const likelyCause = partitionFilterCause(baseResult, headResult);
  return {
    status: "estimated",
    ...common,
    baseBytes: baseResult.bytes,
    headBytes: headResult.bytes,
    runsPerDay,
    monthlyDelta: monthlyDelta(
      baseResult.bytes,
      headResult.bytes,
      pricePerTibFor(model, config),
      runsPerDay,
    ),
    ...(likelyCause !== undefined && { likelyCause }),
    ...(fullRefreshResult !== undefined &&
      "bytes" in fullRefreshResult && { fullRefreshBytes: fullRefreshResult.bytes }),
  };
}

/** Estimate every change and assemble the report. */
export async function estimateChanges(
  changes: readonly ModelChange[],
  runner: DryRunner,
  config: Config,
): Promise<Report> {
  const newTargets = new Set(changes.filter((c) => c.kind === "added").map((c) => c.target));
  const estimates = await Promise.all(
    changes.map((c) => estimateChange(c, runner, config, newTargets)),
  );
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
    ...(config.pricePerTibByLocation !== undefined && {
      pricePerTibByLocation: config.pricePerTibByLocation,
    }),
    limitMonthly: config.limitMonthly,
    overLimit: exceedsLimit(totalMonthlyDelta, config.limitMonthly),
  };
}
