import type { Config, Model } from "./types.ts";

/** Bytes in one tebibyte (2^40). BigQuery bills on-demand queries per TiB. */
export const BYTES_PER_TIB = 2 ** 40;

/** Billing month used for projections. */
export const DAYS_PER_MONTH = 30;

/** Default config. The price is the US on-demand list price; verify against current docs. */
export const DEFAULT_CONFIG: Config = {
  pricePerTib: 6.25,
  limitMonthly: null,
  defaultRunsPerDay: 1,
  runsPerDay: {},
};

export function bytesToTib(bytes: number): number {
  return bytes / BYTES_PER_TIB;
}

/**
 * Projected monthly spend for a query that scans `bytes` per run.
 * Upper bound: ignores the monthly free tier and any caching.
 */
export function monthlyCost(bytes: number, pricePerTib: number, runsPerDay: number): number {
  assertNonNegative("bytes", bytes);
  assertNonNegative("pricePerTib", pricePerTib);
  assertNonNegative("runsPerDay", runsPerDay);
  return bytesToTib(bytes) * pricePerTib * runsPerDay * DAYS_PER_MONTH;
}

/** `delta_TiB x price_per_TiB x runs_per_day x 30`. Negative when the change saves money. */
export function monthlyDelta(
  baseBytes: number,
  headBytes: number,
  pricePerTib: number,
  runsPerDay: number,
): number {
  return (
    monthlyCost(headBytes, pricePerTib, runsPerDay) -
    monthlyCost(baseBytes, pricePerTib, runsPerDay)
  );
}

/**
 * The on-demand price for a model's location: a `pricePerTibByLocation` entry matched
 * without regard to case, else `pricePerTib`. A model with no location (BigQuery picks
 * one at run time) uses `pricePerTib`.
 */
export function pricePerTibFor(model: Pick<Model, "location">, config: Config): number {
  const location = model.location?.toLowerCase();
  if (location !== undefined) {
    for (const [key, price] of Object.entries(config.pricePerTibByLocation ?? {})) {
      if (key.toLowerCase() === location) return price;
    }
  }
  return config.pricePerTib;
}

/**
 * How often a model runs. Precedence: an override for the model's name, then the
 * highest override among its tags, then the default.
 */
export function runsPerDayFor(model: Pick<Model, "name" | "tags">, config: Config): number {
  const byName = config.runsPerDay[model.name];
  if (byName !== undefined) return byName;

  const byTag = model.tags
    .map((tag) => config.runsPerDay[tag])
    .filter((n): n is number => n !== undefined);
  if (byTag.length > 0) return Math.max(...byTag);

  return config.defaultRunsPerDay;
}

/** True when the total exceeds the limit. Exactly at the limit passes; no limit never fails. */
export function exceedsLimit(totalMonthlyDelta: number, limitMonthly: number | null): boolean {
  return limitMonthly !== null && totalMonthlyDelta > limitMonthly;
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number; got ${String(value)}`);
  }
}
