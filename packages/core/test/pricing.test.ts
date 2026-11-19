import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  DEFAULT_CONFIG,
  bytesToTib,
  exceedsLimit,
  monthlyCost,
  monthlyDelta,
  runsPerDayFor,
} from "../src/index.ts";
import type { Config } from "../src/index.ts";

describe("bytesToTib", () => {
  it("uses binary TiB (2^40 bytes)", () => {
    expect(bytesToTib(BYTES_PER_TIB)).toBe(1);
    expect(bytesToTib(BYTES_PER_TIB / 4)).toBe(0.25);
  });
});

describe("monthlyCost", () => {
  it("is TiB x price x runs/day x 30", () => {
    expect(monthlyCost(BYTES_PER_TIB, 6.25, 1)).toBe(187.5);
    expect(monthlyCost(2 * BYTES_PER_TIB, 6.25, 24)).toBe(9000);
  });

  it("is zero for zero bytes or zero runs", () => {
    expect(monthlyCost(0, 6.25, 24)).toBe(0);
    expect(monthlyCost(BYTES_PER_TIB, 6.25, 0)).toBe(0);
  });

  it.each([
    ["bytes", -1, 6.25, 1],
    ["pricePerTib", 1, -6.25, 1],
    ["runsPerDay", 1, 6.25, Number.NaN],
    ["bytes", Number.POSITIVE_INFINITY, 6.25, 1],
  ])("rejects an invalid %s", (_name, bytes, price, runs) => {
    expect(() => monthlyCost(bytes, price, runs)).toThrow(RangeError);
  });
});

describe("monthlyDelta", () => {
  it("is positive when head scans more", () => {
    expect(monthlyDelta(0, BYTES_PER_TIB, 6.25, 1)).toBe(187.5);
  });

  it("is negative when head scans less", () => {
    expect(monthlyDelta(BYTES_PER_TIB, 0, 6.25, 1)).toBe(-187.5);
  });

  it("is zero when bytes are unchanged", () => {
    expect(monthlyDelta(123, 123, 6.25, 24)).toBe(0);
  });
});

describe("runsPerDayFor", () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    defaultRunsPerDay: 1,
    runsPerDay: { hourly: 24, every_6h: 4, orders_daily: 2 },
  };

  it("falls back to the default", () => {
    expect(runsPerDayFor({ name: "x", tags: [] }, config)).toBe(1);
  });

  it("uses a tag override", () => {
    expect(runsPerDayFor({ name: "x", tags: ["hourly"] }, config)).toBe(24);
  });

  it("takes the highest of several tag overrides", () => {
    expect(runsPerDayFor({ name: "x", tags: ["every_6h", "hourly", "other"] }, config)).toBe(24);
  });

  it("prefers a name override over tags", () => {
    expect(runsPerDayFor({ name: "orders_daily", tags: ["hourly"] }, config)).toBe(2);
  });
});

describe("exceedsLimit", () => {
  it("never fails without a limit", () => {
    expect(exceedsLimit(1e9, null)).toBe(false);
  });

  it("fails only strictly above the limit", () => {
    expect(exceedsLimit(99.99, 100)).toBe(false);
    expect(exceedsLimit(100, 100)).toBe(false);
    expect(exceedsLimit(100.01, 100)).toBe(true);
  });

  it("does not fail on savings", () => {
    expect(exceedsLimit(-500, 0)).toBe(false);
  });
});
