import type { DryRunResult, DryRunner, TableInfo } from "./types.ts";

/**
 * Wrap a DryRunner so at most `max` dry runs are in flight at once. `estimateChanges`
 * starts every dry run together, and a large pull request would otherwise hit BigQuery's
 * rate limits.
 */
export function limitConcurrency(runner: DryRunner, max: number): DryRunner {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  let active = 0;
  const waiting: (() => void)[] = [];

  async function limited<T>(call: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await call();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  const table = runner.table?.bind(runner);
  return {
    estimate: (sql: string, location: string | undefined): Promise<DryRunResult> =>
      limited(() => runner.estimate(sql, location)),
    ...(table !== undefined && {
      table: (target: string): Promise<TableInfo | undefined> => limited(() => table(target)),
    }),
  };
}
