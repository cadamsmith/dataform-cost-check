/**
 * Core domain types. Nothing here knows about Dataform, BigQuery's client
 * library, or GitHub: adapters translate into and out of these shapes.
 */

/** The kind of action a model is. Mirrors Dataform's action types. */
export type ModelType = "table" | "incremental" | "view" | "assertion" | "operations";

/** One compiled model, as an adapter hands it to core. */
export interface Model {
  /** Fully qualified target, e.g. `project.dataset.orders_daily`. Unique per compilation. */
  readonly target: string;
  /** Short name used for display and `runs_per_day` overrides, e.g. `orders_daily`. */
  readonly name: string;
  readonly type: ModelType;
  /**
   * The compiled query. For incremental models, the full-refresh query. Empty for a JIT
   * action (`jitCode`), whose SQL Dataform generates only when the workflow runs.
   */
  readonly query: string;
  /** Incremental models only: the compiled incremental (steady-state) query. */
  readonly incrementalQuery?: string;
  /** Statements run before `query` (Dataform `pre_operations`), e.g. `DECLARE` a checkpoint. */
  readonly preOps?: readonly string[];
  /** Incremental models only: statements run before `incrementalQuery`. */
  readonly incrementalPreOps?: readonly string[];
  /**
   * Incremental models with a `uniqueKey` (and the default MERGE strategy, not
   * `INSERT_OVERWRITE`): each run is a MERGE into the existing table, on these key columns,
   * with `updatePartitionFilter` and `incrementalPredicates` (when set) limiting the
   * target rows.
   */
  readonly merge?: {
    readonly uniqueKey: readonly string[];
    readonly updatePartitionFilter?: string;
    /** Extra conditions on the target (`bigquery.incrementalPredicates`, Dataform 3.1+). */
    readonly incrementalPredicates?: readonly string[];
  };
  /**
   * Incremental models with `incrementalStrategy: INSERT_OVERWRITE` (Dataform 3.1+): each
   * run stages the query's rows, then replaces the matching partitions of the existing
   * table with a MERGE, which also reads that table. Not sized beyond the query.
   */
  readonly insertOverwrite?: boolean;
  readonly tags: readonly string[];
  /**
   * Set for a just-in-time action (Dataform 3: `.jitCode()` in JavaScript, or
   * `compilation_mode: "jit"` in SQLX): the JavaScript that builds its SQL at run time. The
   * compiled output carries no query, so a dry run cannot size it. Compared between base and
   * head so an edit still counts as a change; never rendered.
   */
  readonly jitCode?: string;
  /**
   * BigQuery location the query runs in, e.g. `US` or `europe-west2`. Absent when the
   * project sets none; BigQuery then picks the location from the datasets the query reads.
   */
  readonly location?: string;
}

export type ChangeKind = "added" | "removed" | "modified";

/** A model whose compiled SQL differs between base and head, or that exists on one side only. */
export type ModelChange =
  | { readonly kind: "added"; readonly target: string; readonly head: Model }
  | { readonly kind: "removed"; readonly target: string; readonly base: Model }
  | {
      readonly kind: "modified";
      readonly target: string;
      readonly base: Model;
      readonly head: Model;
      /**
       * Set when the model's own SQL did not change but it reads views this pull request
       * changes: their short names. Its queries then carry those views inlined.
       */
      readonly viaViews?: readonly string[];
    };

/** What a dry run returns: bytes the query would process, or why it could not tell. */
export type DryRunResult =
  | {
      readonly bytes: number;
      /**
       * Tables the query reads that are partitioned, as `project.dataset.table`. Absent
       * when the runner cannot tell. Tables read through a view are not listed.
       */
      readonly partitionedTables?: readonly string[] | undefined;
    }
  | {
      /**
       * BigQuery's own message. It can quote the query (string literals, identifiers), so
       * it goes to the job log only, never into the PR comment.
       */
      readonly error: string;
      /** What kind of failure it was, safe to show in the comment. */
      readonly errorKind: DryRunErrorKind;
    };

/**
 * Why a dry run failed, as far as the comment is concerned. The comment names the kind
 * and points to the job log for BigQuery's message (docs/design.md, "No query text").
 */
export type DryRunErrorKind =
  | "permission-denied"
  | "api-disabled"
  | "not-found"
  | "partition-filter-required"
  | "query-error"
  | "unknown";

/**
 * The only seam to BigQuery. `packages/bigquery` implements it against the API;
 * tests and the scaffolded action use a fake.
 */
export interface DryRunner {
  /** `location` undefined means "let BigQuery choose from the referenced datasets". */
  estimate(sql: string, location: string | undefined): Promise<DryRunResult>;
  /**
   * An existing table's top-level columns and logical size, as `project.dataset.table`.
   * Undefined when it does not exist or cannot be read. Optional: without it, MERGE
   * incrementals are sized from their query alone.
   */
  table?(target: string): Promise<TableInfo | undefined>;
}

/** What a MERGE estimate needs to know about the existing target table. */
export interface TableInfo {
  readonly columns: readonly string[];
  /** Logical bytes, what an on-demand scan of every column would bill. */
  readonly bytes: number;
}

/**
 * How a unique-key incremental's MERGE was sized. `merge`: a dry run of the MERGE
 * statement Dataform runs, read of the existing table included, so the figure is exact.
 * `range`: that dry run failed (it needs write access to the table), so the figure is
 * the query alone, and a run reads between `fromBytes` and `toBytes` (the query plus the
 * whole table). `query`: the table could not be looked up (say it does not exist yet), so
 * the figure is the query alone, a lower bound.
 */
export type MergeSizing =
  | { readonly by: "merge" }
  | {
      readonly by: "range";
      readonly fromBytes: number;
      readonly toBytes: number;
      readonly errorKind: DryRunErrorKind;
      /** BigQuery's message, for the job log only. */
      readonly detail: string;
    }
  | { readonly by: "query" };

/** Most likely reason for a cost jump, when a heuristic can tell. */
export interface LikelyCause {
  readonly kind: "partition-filter-removed";
  /** The partitioned table both sides read, as `project.dataset.table`. */
  readonly table: string;
}

/** The outcome for one changed model. */
export type Estimate =
  | {
      readonly status: "estimated";
      readonly target: string;
      readonly name: string;
      readonly kind: ChangeKind;
      readonly type: ModelType;
      /** BigQuery location the model runs in, when the project sets one. */
      readonly location?: string;
      /** Bytes per run at base; 0 for added models. */
      readonly baseBytes: number;
      /** Bytes per run at head; 0 for removed models. */
      readonly headBytes: number;
      /** Runs per day at head (at base, for removed models). */
      readonly runsPerDay: number;
      /** Runs per day at base, when it differs from `runsPerDay` (e.g. a new tag). */
      readonly baseRunsPerDay?: number;
      /**
       * USD per TiB this model was priced at. 0 means bytes do not map to dollars here
       * (for example, slot-based pricing): the comment shows bytes, not dollars.
       */
      readonly pricePerTib: number;
      /** Head minus base, in USD per month. An upper-bound estimate. */
      readonly monthlyDelta: number;
      readonly likelyCause?: LikelyCause;
      /**
       * Incremental models only: bytes a full refresh of the head version would process.
       * Reported beside the estimate, never added to `monthlyDelta`. Absent when that dry
       * run failed.
       */
      readonly fullRefreshBytes?: number;
      /** One full rebuild of this model, before and after. Absent when it could not be sized. */
      readonly fullRefresh?: FullRefresh;
      /** True when either side is an incremental model. */
      readonly involvesIncremental?: boolean;
      /** The changed views this model reads, when that is the only reason it is listed. */
      readonly viaViews?: readonly string[];
      /** Head (base, if removed) replaces partitions (`Model.insertOverwrite`): a lower bound. */
      readonly insertOverwrite?: boolean;
      /**
       * Incremental models with a `uniqueKey`: the run is a MERGE that also reads the
       * existing table. `sizing` says whether that read is counted. `readsOwnTable` is
       * true when the incremental query reads the model's own table (say a `MAX(...)` from
       * `self()`): `updatePartitionFilter` then does not limit the read (measured
       * 2026-11-23).
       */
      readonly merge?: {
        readonly partitionFiltered: boolean;
        readonly readsOwnTable: boolean;
        readonly sizing: MergeSizing;
        /** Only the base version has a unique key: this pull request drops it. */
        readonly baseOnly?: boolean;
      };
    }
  | {
      /** Deliberately not estimated, e.g. views or custom operations. */
      readonly status: "skipped";
      readonly target: string;
      readonly name: string;
      readonly kind: ChangeKind;
      readonly type: ModelType;
      readonly reason: string;
    }
  | {
      /** Tried and failed, e.g. the dry run errored. Reported plainly, never guessed. */
      readonly status: "unestimable";
      readonly target: string;
      readonly name: string;
      readonly kind: ChangeKind;
      readonly type: ModelType;
      readonly reason: string;
      /** The dry run failure behind it, when there was one. */
      readonly errorKind?: DryRunErrorKind;
      /**
       * BigQuery's message, for the job log only. Never rendered into the comment: it can
       * quote the query.
       */
      readonly detail?: string;
      /**
       * Set when the failure is explained by the query reading a table that the same pull
       * request creates, which does not exist yet: that table's target.
       */
      readonly newUpstream?: string;
      /**
       * Set when the query filters on a variable declared in `pre_operations`: its name.
       * A dry run cannot size such a query, so it is not tried.
       */
      readonly preOpsVariable?: string;
      /**
       * Set when the query reads a temp table created in `pre_operations`: its name. It
       * exists only inside Dataform's script, so the query alone is not dry-run.
       */
      readonly preOpsTempTable?: string;
      /**
       * True when either side is a JIT action (`Model.jitCode`): its SQL exists only at run
       * time, so no dry run is tried.
       */
      readonly jit?: boolean;
      /**
       * One full rebuild, before and after, when it could be sized even though the
       * steady state could not: a new incremental's first run, or an incremental whose
       * pre-operations block only its incremental query.
       */
      readonly fullRefresh?: FullRefresh;
      /** True when either side is an incremental model. */
      readonly involvesIncremental?: boolean;
    };

/**
 * One full rebuild of a model from scratch, before and after: the full-refresh query for
 * an incremental, the normal query otherwise. Each side at its own price. Never part of
 * the monthly figure.
 */
export interface FullRefresh {
  readonly baseBytes: number;
  readonly headBytes: number;
  readonly baseUsd: number;
  readonly headUsd: number;
}

/** User configuration, normally read from `dataform-cost-check.yml`. */
export interface Config {
  /** USD per TiB scanned (on-demand pricing). */
  readonly pricePerTib: number;
  /**
   * USD per TiB by BigQuery location (e.g. `EU`, `asia-northeast1`), matched without
   * regard to case. Models whose location is not listed, or unset, use `pricePerTib`.
   */
  readonly pricePerTibByLocation?: Readonly<Record<string, number>>;
  /**
   * Price models by Google's on-demand list price for their location
   * (`ON_DEMAND_PRICE_PER_TIB`). On when the config sets no `price_per_tib`, so a price the
   * team sets (a discount, or 0 for slot-based pricing) always wins.
   */
  readonly builtInRegionPrices?: boolean;
  /** Fail the check when the total monthly delta exceeds this. `null` disables the limit. */
  readonly limitMonthly: number | null;
  readonly defaultRunsPerDay: number;
  /** Overrides keyed by model name or Dataform tag. */
  readonly runsPerDay: Readonly<Record<string, number>>;
  /**
   * Opt-in: show each changed model's last run from BigQuery's job records. Needs
   * `bigquery.jobs.listAll`; never a billed query.
   */
  readonly history?: boolean;
}

/** One past run of a table, from BigQuery's job records. History, never a forecast. */
export interface RefreshRun {
  /** When the run finished, ISO 8601. */
  readonly endedAt: string;
  readonly durationMs: number;
  /** Slot time used; for slot-based (Editions) pricing, this is what is paid for. */
  readonly slotMs: number;
  /**
   * Bytes the run processed (`totalBytesProcessed`), the same measure as the dry-run
   * figures. For a SCRIPT job, everything it ran, pre-operations included. Undefined when
   * the job record has none.
   */
  readonly bytesProcessed?: number;
  /**
   * True when the run rebuilt the table (`CREATE TABLE ... AS SELECT`), false when it added
   * to it (`INSERT`, `MERGE`). Matters for incremental models: a full refresh reads far
   * more than a steady-state run.
   */
  readonly rebuilt?: boolean;
}

/** Last runs of the changed models, when the team opted in. */
export type RefreshHistory =
  | {
      readonly status: "ok";
      /** How many days back the job records were read. */
      readonly days: number;
      /** The project whose job records were read. */
      readonly project: string;
      /** How many job records were read. */
      readonly jobsRead: number;
      /**
       * False when the page cap stopped the search before it covered `days` (a busy
       * project): a model not found may still have run in that window.
       */
      readonly complete: boolean;
      /** By target, `project.dataset.table`. */
      readonly runs: Readonly<Record<string, RefreshRun>>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** Everything the PR comment needs. */
export interface Report {
  readonly estimates: readonly Estimate[];
  /** Sum of `monthlyDelta` over estimated models, in USD. */
  readonly totalMonthlyDelta: number;
  readonly pricePerTib: number;
  readonly pricePerTibByLocation?: Readonly<Record<string, number>>;
  /**
   * When built-in list prices were used: the locations priced that way, with their price,
   * and the date the prices were read.
   */
  readonly listPrices?: {
    readonly asOf: string;
    readonly byLocation: Readonly<Record<string, number>>;
  };
  /**
   * One full rebuild of the changed models, when an incremental model is among them. Not
   * part of `totalMonthlyDelta` or the limit. `leftOut` counts incremental models whose
   * rebuild could not be sized.
   */
  readonly fullRefresh?: {
    readonly baseUsd: number;
    readonly headUsd: number;
    readonly leftOut: number;
  };
  readonly limitMonthly: number | null;
  readonly overLimit: boolean;
  /** Present only when refresh history is turned on. */
  readonly history?: RefreshHistory;
}
