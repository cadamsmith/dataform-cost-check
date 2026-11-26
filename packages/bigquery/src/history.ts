import type { RefreshHistory, RefreshRun } from "@dataform-cost-check/core";

const API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";

export interface JobHistoryOptions {
  /** Project whose job records are read (where Dataform runs its jobs). */
  readonly projectId: string;
  readonly getAccessToken: () => Promise<string>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** How far back to look. */
  readonly days?: number;
  /** Pages of up to 1,000 jobs to read at most. */
  readonly maxPages?: number;
}

interface TableRef {
  readonly projectId?: string;
  readonly datasetId?: string;
  readonly tableId?: string;
}

interface Job {
  readonly configuration?: {
    readonly query?: { readonly query?: string; readonly destinationTable?: TableRef };
  };
  readonly statistics?: {
    readonly startTime?: string;
    readonly endTime?: string;
    readonly totalSlotMs?: string;
    readonly totalBytesProcessed?: string;
    /** The primary reservation the job ran on; absent for on-demand jobs. */
    readonly reservation_id?: string;
    readonly query?: { readonly ddlTargetTable?: TableRef; readonly statementType?: string };
  };
  readonly status?: { readonly errorResult?: unknown };
}

interface JobList {
  readonly jobs?: readonly Job[];
  readonly nextPageToken?: string;
  readonly error?: { readonly message?: string };
}

/** `project.dataset.table`, or undefined for anonymous result tables. */
function tableName(ref: TableRef | undefined): string | undefined {
  if (!ref?.projectId || !ref.datasetId || !ref.tableId) return undefined;
  if (ref.datasetId.startsWith("_")) return undefined;
  return `${ref.projectId}.${ref.datasetId}.${ref.tableId}`;
}

/**
 * The table a job wrote. Plain tables are DDL or DML jobs that name it. An incremental model
 * with pre-operations runs as a SCRIPT that names no table, so its SQL is matched against
 * the targets asked for. The SQL is only matched here, never kept or shown.
 */
export function jobTarget(job: Job, targets: ReadonlySet<string>): string | undefined {
  const named =
    tableName(job.statistics?.query?.ddlTargetTable) ??
    tableName(job.configuration?.query?.destinationTable);
  if (named !== undefined) return targets.has(named) ? named : undefined;
  const sql = job.configuration?.query?.query ?? "";
  for (const target of targets) {
    if (writes(sql, target, ADDS) || writes(sql, target, REBUILDS)) return target;
  }
  return undefined;
}

const ADDS = String.raw`INSERT\s+INTO|MERGE(\s+INTO)?`;
const REBUILDS = String.raw`CREATE\s+OR\s+REPLACE\s+TABLE|CREATE\s+TABLE`;

/** Whether `sql` writes `target` with one of the statements in `statements`. */
function writes(sql: string, target: string, statements: string): boolean {
  const quoted = `\`${target}\``.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(${statements})\\s+${quoted}`, "i").test(sql);
}

/**
 * Whether a job that wrote `target` rebuilt it (a full refresh) or added to it (an
 * incremental run). Undefined when it can't tell, e.g. a script that does both.
 */
export function jobRebuilt(job: Job, target: string): boolean | undefined {
  const type = job.statistics?.query?.statementType;
  if (type === "CREATE_TABLE_AS_SELECT") return true;
  if (type === "INSERT" || type === "MERGE") return false;
  const sql = job.configuration?.query?.query ?? "";
  const adds = writes(sql, target, ADDS);
  const rebuilds = writes(sql, target, REBUILDS);
  return adds === rebuilds ? undefined : rebuilds;
}

/**
 * Whether a job ran on a slot reservation (Editions) rather than on-demand. BigQuery names
 * the reservation in `statistics.reservation_id`; on-demand jobs have none. `default-pipeline`
 * is the shared pool for free batch loads, not a reservation the team pays for.
 */
export function onReservation(job: Job): boolean {
  const id = job.statistics?.reservation_id?.trim() ?? "";
  return id !== "" && id !== "default-pipeline";
}

/**
 * The most recent successful run per table, from BigQuery's job records (`jobs.list`), which
 * is free. Opt-in: listing other users' jobs (Dataform runs as its own service account) needs
 * `bigquery.jobs.listAll`. History only: never a forecast.
 */
export async function readRefreshHistory(
  targets: readonly string[],
  options: JobHistoryOptions,
): Promise<RefreshHistory> {
  const fetchImpl = options.fetch ?? fetch;
  const wanted = new Set(targets);
  const days = options.days ?? 7;
  const runs: Record<string, RefreshRun> = {};
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  let pageToken: string | undefined;
  let jobsRead = 0;
  let complete = false;

  for (let page = 0; page < (options.maxPages ?? 5) && wanted.size > 0; page++) {
    const params = new URLSearchParams({
      allUsers: "true",
      projection: "full",
      stateFilter: "done",
      maxResults: "1000",
      minCreationTime: String(since),
      ...(pageToken !== undefined && { pageToken }),
    });
    const response = await fetchImpl(
      `${API_ROOT}/projects/${encodeURIComponent(options.projectId)}/jobs?${params.toString()}`,
      { headers: { authorization: `Bearer ${await options.getAccessToken()}` } },
    );
    const body = (await response.json().catch(() => ({}))) as JobList;
    if (!response.ok) {
      return {
        status: "unavailable",
        reason:
          response.status === 403
            ? "the service account cannot list job history (needs bigquery.jobs.listAll, e.g. BigQuery Resource Viewer)"
            : `job history could not be read (HTTP ${String(response.status)})`,
      };
    }
    // Newest first: the first job found for a table is its last run.
    jobsRead += body.jobs?.length ?? 0;
    for (const job of body.jobs ?? []) {
      if (job.status?.errorResult !== undefined) continue;
      const target = jobTarget(job, wanted);
      if (target === undefined) continue;
      const start = Number(job.statistics?.startTime);
      const end = Number(job.statistics?.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const bytes = Number(job.statistics?.totalBytesProcessed);
      const rebuilt = jobRebuilt(job, target);
      runs[target] = {
        endedAt: new Date(end).toISOString(),
        durationMs: end - start,
        slotMs: Number(job.statistics?.totalSlotMs ?? 0),
        ...(job.statistics?.totalBytesProcessed !== undefined &&
          Number.isFinite(bytes) && { bytesProcessed: bytes }),
        ...(rebuilt !== undefined && { rebuilt }),
        ...(onReservation(job) && { onReservation: true }),
      };
      wanted.delete(target);
    }
    pageToken = body.nextPageToken;
    if (pageToken === undefined) {
      complete = true;
      break;
    }
  }
  // Every table found also means nothing was missed.
  if (wanted.size === 0) complete = true;
  return { status: "ok", days, project: options.projectId, jobsRead, complete, runs };
}
