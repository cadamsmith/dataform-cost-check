import { BYTES_PER_TIB, DEFAULT_CONFIG, FakeDryRunner } from "@dataform-cost-check/core";
import type { Model, Report } from "@dataform-cost-check/core";
import { describe, expect, it } from "vitest";
import { dryRunFailure, failureDetails, runCheck } from "../src/run.ts";

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

  it("keeps BigQuery's message out of the comment", async () => {
    const { report, comment } = await runCheck({
      config: DEFAULT_CONFIG,
      loadModels: (side) => Promise.resolve(side === "base" ? [base] : [head]),
      runner: new FakeDryRunner([[base.query, { bytes: 1024 }]], {
        error: "Syntax error: Unclosed string literal 'secret-customer-id'",
        errorKind: "query-error",
      }),
    });
    expect(comment).not.toContain("secret-customer-id");
    expect(dryRunFailure(report)).not.toContain("secret-customer-id");
    expect(failureDetails(report)).toEqual([
      "orders_daily: Syntax error: Unclosed string literal 'secret-customer-id'",
    ]);
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
    pricePerTib: 6.25,
    monthlyDelta: 0,
  } as const;
  const failed = {
    ...common,
    name: "bad",
    status: "unestimable",
    reason: "Dry run at head failed: permission denied. BigQuery's message is in the job log.",
    errorKind: "permission-denied",
    detail: "Access Denied: Table p:d.secret_table",
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
    expect(message).toContain("bad: Dry run at head failed: permission denied");
    expect(message).not.toContain("secret_table");
  });

  it("passes when at least one dry run succeeded", () => {
    expect(dryRunFailure(report([failed, estimated]))).toBeUndefined();
  });

  it("leaves models reading a table the same PR creates out of the count", () => {
    const newUpstream = { ...failed, name: "reader", newUpstream: "p.d.new" } as const;
    expect(dryRunFailure(report([newUpstream]))).toBeUndefined();
    expect(dryRunFailure(report([newUpstream, estimated]))).toBeUndefined();
    expect(dryRunFailure(report([newUpstream, failed]))).toContain("1 tried");
  });

  it("passes when nothing needed a dry run", () => {
    expect(dryRunFailure(report([]))).toBeUndefined();
    expect(dryRunFailure(report([skipped]))).toBeUndefined();
  });
});
