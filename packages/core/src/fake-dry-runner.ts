import type { DryRunResult, DryRunner, TableInfo } from "./types.ts";

/**
 * In-memory DryRunner for tests and the scaffolded action. Looks up results by exact
 * SQL; unknown SQL returns `fallback` (an error by default, so missing fixtures are loud).
 * Existing tables, for MERGE sizing, come from `tables`; any other target does not exist.
 */
export class FakeDryRunner implements DryRunner {
  readonly calls: { sql: string; location: string | undefined }[] = [];
  readonly #results: ReadonlyMap<string, DryRunResult>;
  readonly #fallback: DryRunResult;
  readonly #tables: ReadonlyMap<string, TableInfo>;

  constructor(
    results: Iterable<readonly [string, DryRunResult]> = [],
    fallback: DryRunResult = {
      error: "FakeDryRunner has no result for this SQL",
      errorKind: "unknown",
    },
    tables: Iterable<readonly [string, TableInfo]> = [],
  ) {
    this.#results = new Map(results);
    this.#fallback = fallback;
    this.#tables = new Map(tables);
  }

  table(target: string): Promise<TableInfo | undefined> {
    return Promise.resolve(this.#tables.get(target));
  }

  estimate(sql: string, location: string | undefined): Promise<DryRunResult> {
    this.calls.push({ sql, location });
    return Promise.resolve(this.#results.get(sql) ?? this.#fallback);
  }
}
