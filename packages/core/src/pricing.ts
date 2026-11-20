import { ON_DEMAND_PRICE_PER_TIB } from "./region-prices.ts";
import type { Config, Model } from "./types.ts";

/** Bytes in one tebibyte (2^40). BigQuery bills on-demand queries per TiB. */
export const BYTES_PER_TIB = 2 ** 40;

/** Billing month used for projections. */
export const DAYS_PER_MONTH = 30;

/** Default config. The price is the US on-demand list price; verify against current docs. */
export const DEFAULT_CONFIG: Config = {
  pricePerTib: 6.25,
  builtInRegionPrices: true,
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
 * The on-demand price for a model's location, in this order: the team's own
 * `pricePerTibByLocation` entry; Google's list price for that location, when
 * `builtInRegionPrices` is on; else `pricePerTib`. Locations match without regard to case.
 * A model with no location (BigQuery picks one at run time) uses `pricePerTib`.
 */
export function pricePerTibFor(model: Pick<Model, "location">, config: Config): number {
  const location = model.location;
  if (location !== undefined) {
    const own = lookup(config.pricePerTibByLocation, location);
    if (own !== undefined) return own;
    if (config.builtInRegionPrices === true) {
      const list = lookup(ON_DEMAND_PRICE_PER_TIB, location);
      if (list !== undefined) return list;
    }
  }
  return config.pricePerTib;
}

/** Google's list price for a location, when built-in prices apply and it is listed. */
export function listPriceFor(location: string | undefined, config: Config): number | undefined {
  if (location === undefined || config.builtInRegionPrices !== true) return undefined;
  if (lookup(config.pricePerTibByLocation, location) !== undefined) return undefined;
  return lookup(ON_DEMAND_PRICE_PER_TIB, location);
}

function lookup(
  prices: Readonly<Record<string, number>> | undefined,
  location: string,
): number | undefined {
  const wanted = location.toLowerCase();
  for (const [key, price] of Object.entries(prices ?? {})) {
    if (key.toLowerCase() === wanted) return price;
  }
  return undefined;
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
