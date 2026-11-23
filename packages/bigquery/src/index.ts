import { GoogleAuth } from "google-auth-library";
import type {
  DryRunErrorKind,
  DryRunResult,
  DryRunner,
  TableInfo,
} from "@dataform-cost-check/core";

const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";

export interface BigQueryDryRunnerOptions {
  /** Project the dry-run jobs are created in (billing project). */
  readonly projectId: string;
  /**
   * Returns an OAuth access token. Defaults to Application Default Credentials, which is
   * what `google-github-actions/auth` sets up with Workload Identity Federation.
   */
  readonly getAccessToken?: () => Promise<string>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

interface TableReference {
  readonly projectId?: string;
  readonly datasetId?: string;
  readonly tableId?: string;
}

/** The parts of a `jobs.insert` response this runner reads. */
interface JobResponse {
  readonly statistics?: {
    readonly totalBytesProcessed?: string;
    readonly query?: {
      readonly totalBytesProcessed?: string;
      readonly referencedTables?: readonly TableReference[];
    };
  };
  readonly error?: ApiError;
}

/** The parts of a Google API error body this runner reads. */
interface ApiError {
  readonly message?: string;
  readonly errors?: readonly { readonly reason?: string }[];
  readonly details?: readonly { readonly reason?: string }[];
}

/**
 * Sort a failed dry run into a kind the PR comment can name without quoting BigQuery's
 * message, which can contain parts of the query. Uses the HTTP status and the error
 * reasons; only the required-partition-filter case has no reason of its own, so it is
 * matched on the message.
 */
export function classifyError(status: number, error: ApiError | undefined): DryRunErrorKind {
  const reasons = [...(error?.errors ?? []), ...(error?.details ?? [])].map((e) => e.reason);
  if (reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED")) {
    return "api-disabled";
  }
  if (/without a filter over column/i.test(error?.message ?? "")) {
    return "partition-filter-required";
  }
  if (status === 404 || reasons.includes("notFound")) return "not-found";
  if (status === 403 || reasons.includes("accessDenied")) return "permission-denied";
  if (status === 400 || reasons.includes("invalidQuery") || reasons.includes("invalid")) {
    return "query-error";
  }
  return "unknown";
}

/** Access tokens from Application Default Credentials (what google-github-actions/auth sets up). */
export function applicationDefaultToken(): () => Promise<string> {
  const auth = new GoogleAuth({ scopes: [BIGQUERY_SCOPE] });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Google Cloud credentials returned no access token.");
    return token;
  };
}

/**
 * DryRunner backed by BigQuery `jobs.insert` with `dryRun: true`. Dry runs are free and
 * return `totalBytesProcessed` without running the query. This is the only package
 * allowed to touch the network, and it talks only to the user's own BigQuery project.
 *
 * Errors about one query (a missing table, a syntax error, no access to a table) become
 * `{ error }`, so that model is reported as not estimated. Errors about the whole run
 * (bad credentials, rate limits, BigQuery unavailable) throw, because every other model
 * would fail the same way.
 */
export class BigQueryDryRunner implements DryRunner {
  readonly #projectId: string;
  readonly #getAccessToken: () => Promise<string>;
  readonly #fetch: typeof fetch;
  /** `project.dataset.table` → whether it is partitioned; undefined when unknown. */
  readonly #partitioned = new Map<string, Promise<boolean | undefined>>();

  constructor(options: BigQueryDryRunnerOptions) {
    this.#projectId = options.projectId;
    this.#getAccessToken = options.getAccessToken ?? applicationDefaultToken();
    this.#fetch = options.fetch ?? fetch;
  }

  async estimate(sql: string, location: string | undefined): Promise<DryRunResult> {
    const body = {
      configuration: { dryRun: true, query: { query: sql, useLegacySql: false } },
      // No location: BigQuery picks it from the datasets the query reads.
      ...(location !== undefined && {
        jobReference: { projectId: this.#projectId, location },
      }),
    };
    const response = await this.#fetch(
      `${API_ROOT}/projects/${encodeURIComponent(this.#projectId)}/jobs`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.#getAccessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const job = (await response.json().catch(() => ({}))) as JobResponse;

    if (!response.ok) {
      const message = job.error?.message ?? `HTTP ${String(response.status)}`;
      if (response.status === 401 || response.status === 429 || response.status >= 500) {
        throw new Error(`BigQuery dry run failed: ${message}`);
      }
      return { error: message, errorKind: classifyError(response.status, job.error) };
    }

    const bytes = job.statistics?.totalBytesProcessed ?? job.statistics?.query?.totalBytesProcessed;
    if (bytes === undefined || !/^\d+$/.test(bytes)) {
      return {
        error: "BigQuery returned no bytes-processed figure for the dry run.",
        errorKind: "unknown",
      };
    }
    const partitionedTables = await this.#partitionedTables(
      job.statistics?.query?.referencedTables ?? [],
    );
    return { bytes: Number(bytes), partitionedTables };
  }

  /**
   * The existing table's top-level columns and logical size, for sizing a MERGE. Reads
   * metadata only (`tables.get`, free). Undefined when the table does not exist, is not a
   * table, or the lookup fails for any reason: the model is then sized from its query.
   */
  async table(target: string): Promise<TableInfo | undefined> {
    const parts = target.split(".");
    if (parts.length < 2) return undefined;
    const table = parts.at(-1) ?? "";
    const dataset = parts.at(-2) ?? "";
    // A domain-scoped project (`example.com:project`) has a dot of its own.
    const project = parts.length > 2 ? parts.slice(0, -2).join(".") : this.#projectId;
    try {
      const e = encodeURIComponent;
      const response = await this.#fetch(
        `${API_ROOT}/projects/${e(project)}/datasets/${e(dataset)}/tables/${e(table)}?fields=type,numBytes,schema/fields/name`,
        { headers: { authorization: `Bearer ${await this.#getAccessToken()}` } },
      );
      if (!response.ok) return undefined;
      const meta = (await response.json()) as {
        type?: string;
        numBytes?: string;
        schema?: { fields?: readonly { name?: string }[] };
      };
      const columns = (meta.schema?.fields ?? []).flatMap((f) => (f.name ? [f.name] : []));
      if (meta.type !== "TABLE" || columns.length === 0) return undefined;
      if (meta.numBytes === undefined || !/^\d+$/.test(meta.numBytes)) return undefined;
      return { columns, bytes: Number(meta.numBytes) };
    } catch {
      return undefined;
    }
  }

  /**
   * Which of the tables a dry run read are partitioned, for the partition-filter
   * heuristic. Extra detail only: a lookup that fails for any reason (no access, a
   * wildcard table, rate limits) leaves that table out instead of failing the estimate.
   */
  async #partitionedTables(refs: readonly TableReference[]): Promise<string[]> {
    const ids = refs.flatMap((r) =>
      r.projectId && r.datasetId && r.tableId && !r.tableId.includes("*")
        ? [[r.projectId, r.datasetId, r.tableId] as const]
        : [],
    );
    const checked = await Promise.all(
      ids.map(async (parts) => {
        const id = parts.join(".");
        let lookup = this.#partitioned.get(id);
        if (lookup === undefined) {
          lookup = this.#isPartitioned(...parts);
          this.#partitioned.set(id, lookup);
        }
        return (await lookup) === true ? [id] : [];
      }),
    );
    return checked.flat();
  }

  async #isPartitioned(
    project: string,
    dataset: string,
    table: string,
  ): Promise<boolean | undefined> {
    try {
      const e = encodeURIComponent;
      const response = await this.#fetch(
        `${API_ROOT}/projects/${e(project)}/datasets/${e(dataset)}/tables/${e(table)}?fields=timePartitioning,rangePartitioning`,
        { headers: { authorization: `Bearer ${await this.#getAccessToken()}` } },
      );
      if (!response.ok) return undefined;
      const meta = (await response.json()) as {
        timePartitioning?: unknown;
        rangePartitioning?: unknown;
      };
      return meta.timePartitioning !== undefined || meta.rangePartitioning !== undefined;
    } catch {
      return undefined;
    }
  }
}
export { jobTarget, readRefreshHistory } from "./history.ts";
export type { JobHistoryOptions } from "./history.ts";
