import type { DryRunResult, DryRunner } from "@dataform-cost-check/core";

export interface BigQueryDryRunnerOptions {
  /** Project the dry-run jobs are created in (billing project). */
  readonly projectId: string;
}

/**
 * DryRunner backed by BigQuery `jobs.insert` with `dryRun: true`. Dry runs are free and
 * return `totalBytesProcessed` without running the query.
 *
 * TODO(milestone 1): implement with the official client. Verify the IAM permission a dry
 * run needs, and authenticate through Workload Identity Federation (no key files).
 * This is the only package allowed to touch the network.
 */
export class BigQueryDryRunner implements DryRunner {
  readonly #projectId: string;

  constructor(options: BigQueryDryRunnerOptions) {
    this.#projectId = options.projectId;
  }

  estimate(_sql: string, location: string | undefined): Promise<DryRunResult> {
    return Promise.reject(
      new Error(
        `BigQueryDryRunner is not implemented yet (project ${this.#projectId}, location ${location ?? "(chosen by BigQuery)"})`,
      ),
    );
  }
}
