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
  /** The compiled query. For incremental models, the full-refresh query. */
  readonly query: string;
  /** Incremental models only: the compiled incremental (steady-state) query. */
  readonly incrementalQuery?: string;
  readonly tags: readonly string[];
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
  | { readonly error: string };

/**
 * The only seam to BigQuery. `packages/bigquery` implements it against the API;
 * tests and the scaffolded action use a fake.
 */
export interface DryRunner {
  /** `location` undefined means "let BigQuery choose from the referenced datasets". */
  estimate(sql: string, location: string | undefined): Promise<DryRunResult>;
}

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
      /** Bytes per run at base; 0 for added models. */
      readonly baseBytes: number;
      /** Bytes per run at head; 0 for removed models. */
      readonly headBytes: number;
      readonly runsPerDay: number;
      /** Head minus base, in USD per month. An upper-bound estimate. */
      readonly monthlyDelta: number;
      readonly likelyCause?: LikelyCause;
    }
  | {
      /** Deliberately not estimated, e.g. views or assertions. */
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
    };

/** User configuration, normally read from `dataform-cost-check.yml`. */
export interface Config {
  /** USD per TiB scanned (on-demand pricing). */
  readonly pricePerTib: number;
  /** Fail the check when the total monthly delta exceeds this. `null` disables the limit. */
  readonly limitMonthly: number | null;
  readonly defaultRunsPerDay: number;
  /** Overrides keyed by model name or Dataform tag. */
  readonly runsPerDay: Readonly<Record<string, number>>;
}

/** Everything the PR comment needs. */
export interface Report {
  readonly estimates: readonly Estimate[];
  /** Sum of `monthlyDelta` over estimated models, in USD. */
  readonly totalMonthlyDelta: number;
  readonly pricePerTib: number;
  readonly limitMonthly: number | null;
  readonly overLimit: boolean;
}
