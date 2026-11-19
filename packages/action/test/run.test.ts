import { BYTES_PER_TIB, DEFAULT_CONFIG, FakeDryRunner } from "@driftline/core";
import type { Model } from "@driftline/core";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/run.ts";

const base: Model = {
  target: "proj.analytics.orders_daily",
  name: "orders_daily",
  type: "table",
  query: "SELECT * FROM orders WHERE day = CURRENT_DATE()",
  tags: [],
  location: "US",
};
const head: Model = { ...base, query: "SELECT * FROM orders" };

describe("runCheck", () => {
  it("diffs, estimates and renders end to end with a fake runner", async () => {
    const { report, comment } = await runCheck({
      config: { ...DEFAULT_CONFIG, limitMonthly: 100 },
      loadModels: (side) => Promise.resolve(side === "base" ? [base] : [head]),
      runner: new FakeDryRunner([
        [base.query, { bytes: 0.04 * BYTES_PER_TIB }],
        [head.query, { bytes: 1.24 * BYTES_PER_TIB }],
      ]),
    });
    expect(report.overLimit).toBe(true);
    expect(report.totalMonthlyDelta).toBeCloseTo(225);
    expect(comment).toContain("+$225.00 / month");
  });
});
