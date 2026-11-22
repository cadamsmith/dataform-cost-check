import { BYTES_PER_TIB, DEFAULT_CONFIG, FakeDryRunner } from "@dataform-cost-check/core";
import type { Model, Report } from "@dataform-cost-check/core";
import { describe, expect, it } from "vitest";
import { dryRunFailure, failureDetails, partitionFilterFailure, runCheck } from "../src/run.ts";

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

  it("says in every rendering when the config file was missing", async () => {
    const result = await runCheck({
      config: DEFAULT_CONFIG,
      loadModels: (side) => Promise.resolve(side === "base" ? [base] : [head]),
      runner: new FakeDryRunner([[base.query, { bytes: 1024 }]]),
      configPath: "dataform-cost-check.yml",
      configFound: false,
    });
    for (const body of [result.comment, result.summary, result.full]) {
      expect(body).toContain("No `dataform-cost-check.yml` found");
    }
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

describe("runCheck history", () => {
  const deps = (history: boolean | undefined, calls: string[][]) => ({
    config: { ...DEFAULT_CONFIG, ...(history !== undefined && { history }) },
    loadModels: (side: "base" | "head") => Promise.resolve(side === "base" ? [base] : [head]),
    runner: new FakeDryRunner([
      [base.query, { bytes: 1 }],
      [head.query, { bytes: 2 }],
    ]),
    readHistory: (targets: readonly string[]) => {
      calls.push([...targets]);
      return Promise.resolve({
        status: "ok" as const,
        days: 7,
        project: "proj",
        jobsRead: 0,
        complete: true,
        runs: {},
      });
    },
  });

  it("reads history only when the config turns it on", async () => {
    const calls: string[][] = [];
    expect((await runCheck(deps(undefined, calls))).report.history).toBeUndefined();
    expect(calls).toEqual([]);
    const on = await runCheck(deps(true, calls));
    expect(calls).toEqual([[base.target]]);
    expect(on.comment).toContain("No run of the changed models found in the last 7 days");
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

  it("blames project setup only for failures that point at it", () => {
    expect(dryRunFailure(report([failed]))).toContain("Check the Google Cloud project");
    const rejected = { ...failed, errorKind: "query-error" } as const;
    const message = dryRunFailure(report([rejected]));
    expect(message).not.toContain("Check the Google Cloud project");
    expect(message).toContain("First error, for bad:");
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

  it("leaves models filtering on a pre_operations variable out of the count", () => {
    const preOps = { ...failed, name: "inc", preOpsVariable: "checkpoint" } as const;
    expect(dryRunFailure(report([preOps]))).toBeUndefined();
    expect(dryRunFailure(report([preOps, failed]))).toContain("1 tried");
  });

  it("passes when nothing needed a dry run", () => {
    expect(dryRunFailure(report([]))).toBeUndefined();
    expect(dryRunFailure(report([skipped]))).toBeUndefined();
  });
});

describe("partitionFilterFailure", () => {
  const requiresFilter = {
    error:
      "Cannot query over table 'proj.raw.orders' without a filter over column(s) 'day' that can be used for partition elimination",
    errorKind: "partition-filter-required",
  } as const;
  const check = (runner: FakeDryRunner) =>
    runCheck({
      config: DEFAULT_CONFIG,
      loadModels: (side) => Promise.resolve(side === "base" ? [base] : [head]),
      runner,
    });

  it("fails a change that drops a required partition filter, and names the model", async () => {
    const { report, comment } = await check(
      new FakeDryRunner([[base.query, { bytes: 1024 }]], requiresFilter),
    );
    expect(partitionFilterFailure(report)).toContain(
      "orders_daily: reads a table that requires a partition filter",
    );
    // Explained, so not blamed on project setup.
    expect(dryRunFailure(report)).toBeUndefined();
    expect(comment).toContain("so it would fail when it runs. This fails the check.");
    expect(comment).not.toContain("'day'");
  });

  it("does not blame the change when base already failed that way", async () => {
    const { report } = await check(new FakeDryRunner([], requiresFilter));
    expect(partitionFilterFailure(report)).toBeUndefined();
    expect(dryRunFailure(report)).toContain("Dry run at base failed");
  });
});
