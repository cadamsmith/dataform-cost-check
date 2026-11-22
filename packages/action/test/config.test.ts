import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "@dataform-cost-check/core";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  it("reads the documented example", () => {
    const text = [
      "price_per_tib: 6.25",
      "limit_monthly: 100",
      "default_runs_per_day: 1",
      "runs_per_day:",
      "  hourly: 24",
    ].join("\n");
    expect(parseConfig(text)).toEqual({
      pricePerTib: 6.25,
      builtInRegionPrices: false,
      limitMonthly: 100,
      defaultRunsPerDay: 1,
      runsPerDay: { hourly: 24 },
    });
  });

  it("uses Google's list prices only when the config sets no price_per_tib", () => {
    expect(parseConfig("limit_monthly: 100").builtInRegionPrices).toBe(true);
    expect(parseConfig("price_per_tib: 0").builtInRegionPrices).toBe(false);
  });

  it("parses the example file in the repository", () => {
    const text = readFileSync(
      new URL("../../../dataform-cost-check.example.yml", import.meta.url),
      "utf8",
    );
    expect(parseConfig(text)).toMatchObject({ pricePerTib: 6.25, limitMonthly: 100 });
  });

  it("reads prices by location", () => {
    expect(
      parseConfig("price_per_tib_by_location:\n  EU: 6.25\n  asia-northeast1: 7.5"),
    ).toMatchObject({ pricePerTibByLocation: { EU: 6.25, "asia-northeast1": 7.5 } });
  });

  it("falls back to defaults for an empty file", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ["price_per_tib: -1", /price_per_tib/],
    ["limit_monthly: lots", /limit_monthly/],
    ["runs_per_day: [1, 2]", /runs_per_day/],
    ["runs_per_day:\n  hourly: x", /runs_per_day.hourly/],
    ["price_per_tib_by_location: 5", /price_per_tib_by_location must be a mapping/],
    ["price_per_tib_by_location:\n  EU: -1", /price_per_tib_by_location.EU/],
    ["price_per_tb: 5", /unknown key "price_per_tb"/],
    ["- a list", /mapping/],
  ])("rejects %j", (text, message) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe("history", () => {
  it("is off unless turned on, and must be a boolean", () => {
    expect(parseConfig("price_per_tib: 6.25").history).toBeUndefined();
    expect(parseConfig("history: true").history).toBe(true);
    expect(() => parseConfig("history: yes please")).toThrow(/history must be true or false/);
  });
});

describe("loadConfig", () => {
  const fs = (files: Record<string, string>) => ({
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p] ?? "",
  });

  it("reads the file when it exists", () => {
    const { config, found } = loadConfig("ci/cost.yml", fs({ "ci/cost.yml": "limit_monthly: 5" }));
    expect(found).toBe(true);
    expect(config.limitMonthly).toBe(5);
  });

  it("uses the defaults when the default file is missing", () => {
    expect(loadConfig("dataform-cost-check.yml", fs({}))).toEqual({
      config: DEFAULT_CONFIG,
      found: false,
    });
  });

  it("fails when a path other than the default is missing", () => {
    expect(() => loadConfig("ci/cost.yml", fs({}))).toThrow(
      "config-path is set to ci/cost.yml, but there is no such file",
    );
  });
});
