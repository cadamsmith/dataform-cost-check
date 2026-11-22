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
  // Own keys only: a model or tag called "constructor" must not find Object's.
  const override = (key: string) =>
    Object.hasOwn(config.runsPerDay, key) ? config.runsPerDay[key] : undefined;
  const byName = override(model.name);
  if (byName !== undefined) return byName;

  const byTag = model.tags.map(override).filter((n): n is number => n !== undefined);
  if (byTag.length > 0) return Math.max(...byTag);

  return config.defaultRunsPerDay;
}

/**
 * How many days of job records to search for refresh history: twice the longest interval
 * between runs in the config, so a weekly run that slips a few days is still found. At
 * least 7 days, at most 30 (`jobs.list` pages are capped anyway).
 */
export function historyDays(config: Config): number {
  const rates = [config.defaultRunsPerDay, ...Object.values(config.runsPerDay)].filter(
    (r) => r > 0,
  );
  const slowest = rates.length === 0 ? 1 : Math.min(...rates);
  return Math.min(30, Math.max(7, Math.ceil(2 / slowest - 0.001)));
}

/**
 * Runs as a reader would say them: `24 / day`, `1 / week`, `every 3 days`. Fractions of a
 * day that are not a whole number of days stay per day, e.g. `0.3 / day`.
 */
export function formatRuns(runsPerDay: number): string {
  const short = (n: number) => String(Number(n.toFixed(2)));
  if (runsPerDay >= 1 || runsPerDay === 0) return `${short(runsPerDay)} / day`;
  const days = 1 / runsPerDay;
  const whole = Math.round(days);
  // 0.142857 is 7.000007 days: close enough to a week.
  if (Math.abs(days - whole) < 0.01)
    return whole === 7 ? "1 / week" : `every ${String(whole)} days`;
  return `${short(runsPerDay)} / day`;
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
