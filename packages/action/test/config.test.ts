import { DEFAULT_CONFIG } from "@driftline/core";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";

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
      limitMonthly: 100,
      defaultRunsPerDay: 1,
      runsPerDay: { hourly: 24 },
    });
  });

  it("falls back to defaults for an empty file", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ["price_per_tib: -1", /price_per_tib/],
    ["limit_monthly: lots", /limit_monthly/],
    ["runs_per_day: [1, 2]", /runs_per_day/],
    ["runs_per_day:\n  hourly: x", /runs_per_day.hourly/],
    ["price_per_tb: 5", /unknown key "price_per_tb"/],
    ["- a list", /mapping/],
  ])("rejects %j", (text, message) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(message);
  });
});
