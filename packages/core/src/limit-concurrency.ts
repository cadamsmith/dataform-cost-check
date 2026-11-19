import type { DryRunResult, DryRunner } from "./types.ts";

/**
 * Wrap a DryRunner so at most `max` dry runs are in flight at once. `estimateChanges`
 * starts every dry run together, and a large pull request would otherwise hit BigQuery's
 * rate limits.
 */
export function limitConcurrency(runner: DryRunner, max: number): DryRunner {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  let active = 0;
  const waiting: (() => void)[] = [];

  return {
    async estimate(sql: string, location: string | undefined): Promise<DryRunResult> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await runner.estimate(sql, location);
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
}
