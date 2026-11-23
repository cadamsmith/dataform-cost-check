import {
  bytesToTib,
  exceedsLimit,
  listPriceFor,
  monthlyCost,
  pricePerTibFor,
  runsPerDayFor,
} from "./pricing.ts";
import { ON_DEMAND_PRICES_AS_OF } from "./region-prices.ts";
import { mergeSql } from "./merge.ts";
import { formatBytes } from "./render.ts";
import type {
  Config,
  DryRunErrorKind,
  DryRunResult,
  DryRunner,
  Estimate,
  LikelyCause,
  MergeSizing,
  Model,
  ModelChange,
  Report,
} from "./types.ts";

/** How many times more a run must read before a lost partition filter is suspected. */
export const PARTITION_JUMP_RATIO = 10;
/** And by how much, per run, so small tables jumping from 1 MiB to 20 MiB are not flagged. */
export const PARTITION_JUMP_MIN_BYTES = 2 ** 30;

type DryRunBytes = Extract<DryRunResult, { bytes: number }>;
type DryRunError = Extract<DryRunResult, { error: string }>;

/**
 * What the comment says about each kind of dry run failure. BigQuery's own message can
 * quote the query, so it goes to the job log only (docs/design.md, "No query text").
 */
export const ERROR_KIND_TEXT: Readonly<Record<DryRunErrorKind, string>> = {
  "permission-denied": "permission denied",
  "api-disabled": "the BigQuery API is not enabled in the dry-run project",
  "not-found": "a table or dataset it reads was not found",
  "partition-filter-required":
    "a table it reads requires a partition filter and the query has none, so it would also fail when it runs",
  "query-error": "BigQuery rejected the query",
  unknown: "the dry run returned an error",
};

export const PARTITION_FILTER_REQUIRED_REASON =
  "Reads a table that requires a partition filter, and this change leaves the query without one, so it would fail when it runs. This fails the check.";

function dryRunFailed(side: "base" | "head", result: DryRunError) {
  return {
    status: "unestimable",
    reason: `Dry run at ${side} failed: ${ERROR_KIND_TEXT[result.errorKind]}. BigQuery's message is in the job log.`,
    errorKind: result.errorKind,
    detail: result.error,
  } as const;
}

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

/** The pre-operations that run before `steadyStateSql`. */
function steadyStatePreOps(model: Model): readonly string[] {
  return (model.incrementalQuery !== undefined ? model.incrementalPreOps : model.preOps) ?? [];
}

/**
 * The first variable that `pre_operations` declare and `sql` uses, if any. A dry run of
 * the query alone fails on it, and a dry run of pre-operations plus query counts 0 bytes
 * for the filtered statement (measured 2026-11-20), so such a query is not estimated.
 */
export function preOpsVariableIn(sql: string, preOps: readonly string[]): string | undefined {
  const declared = preOps.flatMap((statement) =>
    [...statement.matchAll(/\bDECLARE\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/gi)].flatMap((m) =>
      (m[1] ?? "").split(",").map((name) => name.trim()),
    ),
  );
  return declared.find((name) => new RegExp(`\\b${name}\\b`, "i").test(sql));
}

/**
 * The first temp table that `pre_operations` create and `sql` reads, if any. A temp table
 * exists only inside the script Dataform runs, so a dry run of the query alone fails on
 * the unknown name; such a query is not estimated.
 */
export function preOpsTempTableIn(sql: string, preOps: readonly string[]): string | undefined {
  const created = preOps.flatMap((statement) =>
    [
      ...statement.matchAll(
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?TEMP(?:ORARY)?\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z_]\w*)`?/gi,
      ),
    ].map((m) => m[1] ?? ""),
  );
  // Not after a dot: `proj.dataset.tenant_scope` is a real table, not the temp one.
  return created.find((name) => new RegExp(`(?<![.\\w])\`?${name}\\b`, "i").test(sql));
}

/** Why pre-operations stop `sql` from being dry-run alone, if they do. */
function preOpsBlocker(
  sql: string,
  preOps: readonly string[],
): { preOpsVariable: string } | { preOpsTempTable: string } | undefined {
  const variable = preOpsVariableIn(sql, preOps);
  if (variable !== undefined) return { preOpsVariable: variable };
  const table = preOpsTempTableIn(sql, preOps);
  return table === undefined ? undefined : { preOpsTempTable: table };
}

/** A dry run of an incremental model's full-refresh query, unless pre-operations block it. */
function fullRefreshRun(
  model: Model | undefined,
  runner: DryRunner,
): Promise<DryRunResult> | undefined {
  if (model?.incrementalQuery === undefined) return undefined;
  if (preOpsBlocker(model.query, model.preOps ?? []) !== undefined) return undefined;
  return runner.estimate(model.query, model.location);
}

/**
 * Bytes one full rebuild of a side reads: 0 when the side does not exist or is not
 * estimated (a view), its normal run for a table or assertion, its full-refresh query for
 * an incremental. Undefined when that full refresh could not be sized.
 */
function fullRebuildBytes(
  model: Model | undefined,
  run: DryRunResult,
  fullRefresh: DryRunResult | undefined,
): number | undefined {
  if (model === undefined) return 0;
  if (model.incrementalQuery === undefined) return "bytes" in run ? run.bytes : undefined;
  return fullRefresh !== undefined && "bytes" in fullRefresh ? fullRefresh.bytes : undefined;
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

  const baseModel = change.kind === "modified" ? change.base : model;
  const involvesIncremental =
    base?.incrementalQuery !== undefined || head?.incrementalQuery !== undefined;
  /** One rebuild of both sides, priced each at its own price; undefined if either is unsized. */
  const rebuild = (baseBytes: number | undefined, headBytes: number | undefined) =>
    baseBytes === undefined || headBytes === undefined
      ? undefined
      : {
          baseBytes,
          headBytes,
          baseUsd: bytesToTib(baseBytes) * pricePerTibFor(baseModel, config),
          headUsd: bytesToTib(headBytes) * pricePerTibFor(model, config),
        };

  for (const side of [base, head]) {
    if (side === undefined) continue;
    const blocker = preOpsBlocker(steadyStateSql(side), steadyStatePreOps(side));
    if (blocker !== undefined) {
      // The steady-state query cannot be dry-run, but an incremental's full-refresh query
      // often can (a checkpoint is declared only for incremental runs).
      const blocked: DryRunResult = { error: "blocked by pre_operations", errorKind: "unknown" };
      const [baseFull, headFull] = await Promise.all([
        fullRefreshRun(base, runner),
        fullRefreshRun(head, runner),
      ]);
      const fullRefresh = rebuild(
        fullRebuildBytes(base, blocked, baseFull),
        fullRebuildBytes(head, blocked, headFull),
      );
      return {
        status: "unestimable",
        ...common,
        ...(fullRefresh !== undefined && { fullRefresh }),
        ...(involvesIncremental && { involvesIncremental }),
        reason:
          "preOpsVariable" in blocker
            ? `Filters on \`${blocker.preOpsVariable}\`, a variable set in pre_operations, which a dry run cannot size.`
            : `Reads \`${blocker.preOpsTempTable}\`, a temp table created in pre_operations, which a dry run of the query alone cannot see.`,
        ...blocker,
      };
    }
  }

  const [baseResult, headResult, fullRefreshResult, baseFullRefreshResult] = await Promise.all([
    base === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(base), base.location),
    head === undefined ? { bytes: 0 } : runner.estimate(steadyStateSql(head), head.location),
    fullRefreshRun(head, runner),
    fullRefreshRun(base, runner),
  ]);

  if ("error" in baseResult) {
    return { ...common, ...dryRunFailed("base", baseResult) };
  }
  if ("error" in headResult) {
    const upstream =
      head === undefined
        ? undefined
        : readsNewTarget(steadyStateSql(head), change.target, newTargets);
    if (
      change.kind === "added" &&
      head?.incrementalQuery !== undefined &&
      steadyStateSql(head).includes(`\`${change.target}\``)
    ) {
      // A new incremental model's incremental query reads its own table, which does not
      // exist yet. Its first run is a full refresh, which can be sized.
      const firstRun = rebuild(
        0,
        fullRefreshResult !== undefined && "bytes" in fullRefreshResult
          ? fullRefreshResult.bytes
          : undefined,
      );
      const firstRunText =
        fullRefreshResult !== undefined && "bytes" in fullRefreshResult
          ? ` Its first run, a full refresh, would scan up to ${formatBytes(fullRefreshResult.bytes)}.`
          : "";
      return {
        status: "unestimable",
        ...common,
        reason: `New incremental model: its incremental query reads its own table, which this pull request creates, so the monthly estimate waits until it exists.${firstRunText}`,
        errorKind: headResult.errorKind,
        detail: headResult.error,
        newUpstream: change.target,
        involvesIncremental,
        ...(firstRun !== undefined && { fullRefresh: firstRun }),
      };
    }
    if (upstream !== undefined) {
      return {
        status: "unestimable",
        ...common,
        reason: `Reads \`${upstream}\`, which this pull request creates, so it can only be estimated once that table exists.`,
        errorKind: headResult.errorKind,
        detail: headResult.error,
        newUpstream: upstream,
      };
    }
    if (headResult.errorKind === "partition-filter-required") {
      // Base passed and head does not: this change drops a filter that a table it reads
      // requires, so the query would fail when it runs. A real bug, so it fails the check.
      return {
        status: "unestimable",
        ...common,
        reason: `${PARTITION_FILTER_REQUIRED_REASON} BigQuery's message is in the job log.`,
        errorKind: headResult.errorKind,
        detail: headResult.error,
      };
    }
    return { ...common, ...dryRunFailed("head", headResult) };
  }

  // A unique-key incremental runs as a MERGE, which also reads the existing table.
  const merged = await sizeMerges(
    change.target,
    base,
    head,
    baseResult.bytes,
    headResult.bytes,
    runner,
  );
  const baseBytes = merged?.baseBytes ?? baseResult.bytes;
  const headBytes = merged?.headBytes ?? headResult.bytes;
  // The note follows head, or base when head has no key (removed, or the key was dropped).
  const shown = change.kind === "removed" ? base : head;
  const mergeModel =
    shown?.merge !== undefined ? shown : base?.merge !== undefined ? base : undefined;

  // Each side at its own frequency and price: a new tag or location changes the spend
  // even when the bytes do not.
  const runsPerDay = runsPerDayFor(model, config);
  const pricePerTib = pricePerTibFor(model, config);
  const baseRunsPerDay = runsPerDayFor(baseModel, config);
  const basePricePerTib = pricePerTibFor(baseModel, config);
  const likelyCause = partitionFilterCause(baseResult, headResult);
  const fullRefresh = rebuild(
    fullRebuildBytes(base, baseResult, baseFullRefreshResult),
    fullRebuildBytes(head, headResult, fullRefreshResult),
  );
  return {
    status: "estimated",
    ...common,
    ...(model.location !== undefined && { location: model.location }),
    baseBytes,
    headBytes,
    runsPerDay,
    ...(baseRunsPerDay !== runsPerDay && { baseRunsPerDay }),
    pricePerTib,
    monthlyDelta:
      monthlyCost(headBytes, pricePerTib, runsPerDay) -
      monthlyCost(baseBytes, basePricePerTib, baseRunsPerDay),
    ...(likelyCause !== undefined && { likelyCause }),
    ...(mergeModel?.merge !== undefined &&
      merged !== undefined && {
        merge: {
          partitionFiltered: mergeModel.merge.updatePartitionFilter !== undefined,
          readsOwnTable: steadyStateSql(mergeModel).includes(`\`${change.target}\``),
          sizing: merged.sizing,
          ...(mergeModel !== shown && { baseOnly: true }),
        },
      }),
    ...(change.kind === "modified" &&
      change.viaViews !== undefined && { viaViews: change.viaViews }),
    ...(fullRefreshResult !== undefined &&
      "bytes" in fullRefreshResult && { fullRefreshBytes: fullRefreshResult.bytes }),
    ...(fullRefresh !== undefined && { fullRefresh }),
    ...(involvesIncremental && { involvesIncremental }),
  };
}

/**
 * Size the MERGE of each side that has a unique key (docs/design.md, "Unique-key
 * incremental models"). Undefined when neither side does. A dry run of the MERGE itself is
 * exact, but BigQuery requires write access to the table even for a dry run (measured
 * 2026-11-23), and no read-only query reproduces its figure, because BigQuery prunes the
 * table's partitions through the join. So when that dry run fails, each side keeps its
 * query's bytes and the sizing gives the range up to the query plus the whole table. A
 * failed lookup of the table (say it does not exist yet) also keeps the query's bytes.
 */
async function sizeMerges(
  target: string,
  base: Model | undefined,
  head: Model | undefined,
  baseBytes: number,
  headBytes: number,
  runner: DryRunner,
): Promise<{ baseBytes: number; headBytes: number; sizing: MergeSizing } | undefined> {
  if (base?.merge === undefined && head?.merge === undefined) return undefined;
  const table = runner.table === undefined ? undefined : await runner.table(target);
  if (table === undefined) return { baseBytes, headBytes, sizing: { by: "query" } };

  const mergeRun = (side: Model | undefined) =>
    side?.merge === undefined
      ? undefined
      : runner.estimate(
          mergeSql(target, table.columns, steadyStateSql(side), side.merge.uniqueKey, {
            updatePartitionFilter: side.merge.updatePartitionFilter,
            incrementalPredicates: side.merge.incrementalPredicates,
          }),
          side.location,
        );
  const [baseRun, headRun] = await Promise.all([mergeRun(base), mergeRun(head)]);
  const failed = [headRun, baseRun].find((r): r is DryRunError => r !== undefined && "error" in r);
  if (failed !== undefined) {
    const fromBytes = head?.merge !== undefined ? headBytes : baseBytes;
    return {
      baseBytes,
      headBytes,
      sizing: {
        by: "range",
        fromBytes,
        toBytes: fromBytes + table.bytes,
        errorKind: failed.errorKind,
        detail: failed.error,
      },
    };
  }
  return {
    baseBytes: baseRun !== undefined && "bytes" in baseRun ? baseRun.bytes : baseBytes,
    headBytes: headRun !== undefined && "bytes" in headRun ? headRun.bytes : headBytes,
    sizing: { by: "merge" },
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

/**
 * True when no estimated model has a dollar price, so a spending limit cannot fire. False
 * when nothing was estimated: there is simply nothing to compare.
 */
export function limitCannotApply(report: Report): boolean {
  const estimated = report.estimates.filter((e) => e.status === "estimated");
  return (
    report.limitMonthly !== null &&
    estimated.length > 0 &&
    estimated.every((e) => e.pricePerTib === 0)
  );
}

/** The built-in list prices the estimates used, by location, for the comment's footer. */
function listPrices(estimates: readonly Estimate[], config: Config): Pick<Report, "listPrices"> {
  const byLocation: Record<string, number> = {};
  for (const e of estimates) {
    if (e.status !== "estimated") continue;
    const price = listPriceFor(e.location, config);
    if (price !== undefined && e.location !== undefined) byLocation[e.location] = price;
  }
  return Object.keys(byLocation).length === 0
    ? {}
    : { listPrices: { asOf: ON_DEMAND_PRICES_AS_OF, byLocation } };
}

/**
 * One full rebuild of the changed models, before and after, when an incremental model is
 * among them (for tables alone it would repeat the per-run figures). Never part of the
 * monthly total or the limit. Counts the changed models whose rebuild could not be sized
 * (a failed dry run, a temp table in pre-operations), so it never undercounts silently.
 */
function fullRefreshTotal(estimates: readonly Estimate[]): Pick<Report, "fullRefresh"> {
  let baseUsd = 0;
  let headUsd = 0;
  let incremental = 0;
  let leftOut = 0;
  for (const e of estimates) {
    if (e.status === "skipped") continue;
    if (e.involvesIncremental === true) incremental++;
    if (e.fullRefresh === undefined) {
      leftOut++;
      continue;
    }
    baseUsd += e.fullRefresh.baseUsd;
    headUsd += e.fullRefresh.headUsd;
  }
  return incremental === 0 ? {} : { fullRefresh: { baseUsd, headUsd, leftOut } };
}

/** Total the estimates and apply the limit. Pure. */
export function buildReport(estimates: readonly Estimate[], config: Config): Report {
  const sum = estimates.reduce(
    (total, e) => (e.status === "estimated" ? total + e.monthlyDelta : total),
    0,
  );
  // Changes that cancel out can leave float noise (0.1 + 0.2 - 0.3), which would read as an
  // increase and fail a limit of 0. Nothing real is this small: a byte a day is ~2e-10.
  const totalMonthlyDelta = Math.abs(sum) < 1e-9 ? 0 : sum;
  return {
    estimates,
    totalMonthlyDelta,
    pricePerTib: config.pricePerTib,
    ...(config.pricePerTibByLocation !== undefined && {
      pricePerTibByLocation: config.pricePerTibByLocation,
    }),
    ...listPrices(estimates, config),
    ...fullRefreshTotal(estimates),
    limitMonthly: config.limitMonthly,
    overLimit: exceedsLimit(totalMonthlyDelta, config.limitMonthly),
  };
}
