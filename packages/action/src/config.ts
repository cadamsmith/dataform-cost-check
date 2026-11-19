import { DEFAULT_CONFIG } from "@driftline/core";
import type { Config } from "@driftline/core";
import { parse } from "yaml";

/** Parse and validate `driftline.yml`. Missing keys fall back to defaults. */
export function parseConfig(text: string): Config {
  const raw: unknown = parse(text) ?? {};
  if (!isRecord(raw)) throw new ConfigError("the config must be a YAML mapping");

  const known = new Set(["price_per_tib", "limit_monthly", "default_runs_per_day", "runs_per_day"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ConfigError(`unknown key "${key}"`);
  }

  const runsPerDay: Record<string, number> = {};
  const rawRuns = raw.runs_per_day ?? {};
  if (!isRecord(rawRuns)) throw new ConfigError("runs_per_day must be a mapping of name to number");
  for (const [name, value] of Object.entries(rawRuns)) {
    runsPerDay[name] = nonNegative(`runs_per_day.${name}`, value);
  }

  return {
    pricePerTib: optional("price_per_tib", raw.price_per_tib, DEFAULT_CONFIG.pricePerTib),
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
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid driftline config: ${message}`);
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
