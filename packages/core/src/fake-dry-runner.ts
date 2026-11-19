import type { DryRunResult, DryRunner } from "./types.ts";

/**
 * In-memory DryRunner for tests and the scaffolded action. Looks up results by exact
 * SQL; unknown SQL returns `fallback` (an error by default, so missing fixtures are loud).
 */
export class FakeDryRunner implements DryRunner {
  readonly calls: { sql: string; location: string }[] = [];
  readonly #results: ReadonlyMap<string, DryRunResult>;
  readonly #fallback: DryRunResult;

  constructor(
    results: Iterable<readonly [string, DryRunResult]> = [],
    fallback: DryRunResult = { error: "FakeDryRunner has no result for this SQL" },
  ) {
    this.#results = new Map(results);
    this.#fallback = fallback;
  }

  estimate(sql: string, location: string): Promise<DryRunResult> {
    this.calls.push({ sql, location });
    return Promise.resolve(this.#results.get(sql) ?? this.#fallback);
  }
}
