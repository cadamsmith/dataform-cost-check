import { GoogleAuth } from "google-auth-library";
import type { DryRunResult, DryRunner } from "@dataform-cost-check/core";

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

/** The parts of a `jobs.insert` response this runner reads. */
interface JobResponse {
  readonly statistics?: {
    readonly totalBytesProcessed?: string;
    readonly query?: { readonly totalBytesProcessed?: string };
  };
  readonly error?: { readonly message?: string };
}

function applicationDefaultToken(): () => Promise<string> {
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
      return { error: message };
    }

    const bytes = job.statistics?.totalBytesProcessed ?? job.statistics?.query?.totalBytesProcessed;
    if (bytes === undefined || !/^\d+$/.test(bytes)) {
      return { error: "BigQuery returned no bytes-processed figure for the dry run." };
    }
    return { bytes: Number(bytes) };
  }
}
