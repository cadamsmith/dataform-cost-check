import { BYTES_PER_TIB, DEFAULT_CONFIG, FakeDryRunner } from "@dataform-cost-check/core";
import type { Model, Report } from "@dataform-cost-check/core";
import { describe, expect, it } from "vitest";
import { dryRunFailure, runCheck } from "../src/run.ts";

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

describe("dryRunFailure", () => {
  const common = { target: "p.d.m", kind: "modified", type: "table" } as const;
  const estimated = {
    ...common,
    name: "ok",
    status: "estimated",
    baseBytes: 0,
    headBytes: 0,
    runsPerDay: 1,
    monthlyDelta: 0,
  } as const;
  const failed = {
    ...common,
    name: "bad",
    status: "unestimable",
    reason: "Access Denied",
  } as const;
  const skipped = {
    ...common,
    name: "v",
    type: "view",
    status: "skipped",
    reason: "view",
  } as const;
  const report = (estimates: Report["estimates"]): Report => ({
    estimates,
    totalMonthlyDelta: 0,
    pricePerTib: 6.25,
    limitMonthly: null,
    overLimit: false,
  });

  it("fails when every dry run failed, quoting the first error", () => {
    const message = dryRunFailure(report([skipped, failed, failed]));
    expect(message).toContain("2 tried");
    expect(message).toContain("bad: Access Denied");
  });

  it("passes when at least one dry run succeeded", () => {
    expect(dryRunFailure(report([failed, estimated]))).toBeUndefined();
  });

  it("passes when nothing needed a dry run", () => {
    expect(dryRunFailure(report([]))).toBeUndefined();
    expect(dryRunFailure(report([skipped]))).toBeUndefined();
  });
});
