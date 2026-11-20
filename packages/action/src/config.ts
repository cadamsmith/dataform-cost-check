import { DEFAULT_CONFIG } from "@dataform-cost-check/core";
import type { Config } from "@dataform-cost-check/core";
import { parse } from "yaml";

/** Parse and validate `dataform-cost-check.yml`. Missing keys fall back to defaults. */
export function parseConfig(text: string): Config {
  const raw: unknown = parse(text) ?? {};
  if (!isRecord(raw)) throw new ConfigError("the config must be a YAML mapping");

  const known = new Set([
    "price_per_tib",
    "price_per_tib_by_location",
    "limit_monthly",
    "default_runs_per_day",
    "runs_per_day",
    "history",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ConfigError(`unknown key "${key}"`);
  }

  const runsPerDay: Record<string, number> = {};
  const rawRuns = raw.runs_per_day ?? {};
  if (!isRecord(rawRuns)) throw new ConfigError("runs_per_day must be a mapping of name to number");
  for (const [name, value] of Object.entries(rawRuns)) {
    runsPerDay[name] = nonNegative(`runs_per_day.${name}`, value);
  }

  const rawPrices = raw.price_per_tib_by_location;
  let pricePerTibByLocation: Record<string, number> | undefined;
  if (rawPrices !== undefined && rawPrices !== null) {
    if (!isRecord(rawPrices)) {
      throw new ConfigError("price_per_tib_by_location must be a mapping of location to number");
    }
    pricePerTibByLocation = {};
    for (const [location, value] of Object.entries(rawPrices)) {
      pricePerTibByLocation[location] = nonNegative(`price_per_tib_by_location.${location}`, value);
    }
  }

  return {
    pricePerTib: optional("price_per_tib", raw.price_per_tib, DEFAULT_CONFIG.pricePerTib),
    // Google's list price per location applies only when the team sets no price of its own.
    builtInRegionPrices: raw.price_per_tib === undefined,
    ...(pricePerTibByLocation !== undefined && { pricePerTibByLocation }),
    limitMonthly:
      raw.limit_monthly === undefined || raw.limit_monthly === null
        ? DEFAULT_CONFIG.limitMonthly
        : nonNegative("limit_monthly", raw.limit_monthly),
    defaultRunsPerDay: optional(
      "default_runs_per_day",
      raw.default_runs_per_day,
      DEFAULT_CONFIG.defaultRunsPerDay,
    ),
    runsPerDay,
    ...(raw.history !== undefined && { history: bool("history", raw.history) }),
  };
}

function bool(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${key} must be true or false`);
  return value;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid dataform-cost-check.yml: ${message}`);
    this.name = "ConfigError";
  }
}

function optional(key: string, value: unknown, fallback: number): number {
  return value === undefined ? fallback : nonNegative(key, value);
}

function nonNegative(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${key} must be a non-negative number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
