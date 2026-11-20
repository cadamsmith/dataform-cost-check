import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  DEFAULT_CONFIG,
  FakeDryRunner,
  PARTITION_JUMP_MIN_BYTES,
  PARTITION_JUMP_RATIO,
  buildReport,
  estimateChange,
  estimateChanges,
  limitCannotApply,
  partitionFilterCause,
  readsNewTarget,
} from "../src/index.ts";
import type { Config, Estimate } from "../src/index.ts";
import { model } from "./helpers.ts";

const config: Config = { ...DEFAULT_CONFIG, limitMonthly: 100 };

describe("estimateChange", () => {
  it("prices a modified table from both dry runs", async () => {
    const base = model({ name: "t", query: "old" });
    const head = model({ name: "t", query: "new" });
    const runner = new FakeDryRunner([
      ["old", { bytes: 0 }],
      ["new", { bytes: BYTES_PER_TIB }],
    ]);
    const e = await estimateChange(
      { kind: "modified", target: base.target, base, head },
      runner,
      config,
    );
    expect(e).toMatchObject({
      status: "estimated",
      baseBytes: 0,
      headBytes: BYTES_PER_TIB,
      monthlyDelta: 187.5,
    });
  });

  it("does not dry-run the missing side of added and removed models", async () => {
    const m = model({ name: "t", query: "q" });
    const runner = new FakeDryRunner([["q", { bytes: BYTES_PER_TIB }]]);
    const added = await estimateChange(
      { kind: "added", target: m.target, head: m },
      runner,
      config,
    );
    const removed = await estimateChange(
      { kind: "removed", target: m.target, base: m },
      runner,
      config,
    );
    expect(added).toMatchObject({ baseBytes: 0, monthlyDelta: 187.5 });
    expect(removed).toMatchObject({ headBytes: 0, monthlyDelta: -187.5 });
    expect(runner.calls).toHaveLength(2);
  });

  it("uses the incremental query for incremental models", async () => {
    const m = model({ name: "inc", type: "incremental", query: "full", incrementalQuery: "incr" });
    const runner = new FakeDryRunner([
      ["incr", { bytes: 10 }],
      ["full", { bytes: 5000 }],
    ]);
    const e = await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(runner.calls).toEqual([
      { sql: "incr", location: "US" },
      { sql: "full", location: "US" },
    ]);
    expect(e).toMatchObject({ status: "estimated", headBytes: 10, fullRefreshBytes: 5000 });
  });

  it("keeps the estimate when only the full-refresh dry run fails", async () => {
    const m = model({ name: "inc", type: "incremental", query: "full", incrementalQuery: "incr" });
    const runner = new FakeDryRunner([["incr", { bytes: 10 }]]);
    const e = await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(e).toMatchObject({ status: "estimated", headBytes: 10 });
    expect(e).not.toHaveProperty("fullRefreshBytes");
  });

  it("passes no location to the runner when the model has none", async () => {
    const { location: _location, ...m } = model({ name: "anywhere" });
    const runner = new FakeDryRunner([[m.query, { bytes: 10 }]]);
    await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(runner.calls).toEqual([{ sql: m.query, location: undefined }]);
  });

  it("skips views without calling BigQuery", async () => {
    const m = model({ name: "v", type: "view" });
    const runner = new FakeDryRunner();
    const e = await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(e.status).toBe("skipped");
    expect(runner.calls).toEqual([]);
  });

  it("counts a table turned into a view as a saving", async () => {
    const base = model({ name: "t", query: "q" });
    const head = model({ name: "t", type: "view", query: "q" });
    const runner = new FakeDryRunner([["q", { bytes: BYTES_PER_TIB }]]);
    const e = await estimateChange(
      { kind: "modified", target: base.target, base, head },
      runner,
      config,
    );
    expect(e).toMatchObject({ status: "estimated", headBytes: 0, monthlyDelta: -187.5 });
    expect(runner.calls).toHaveLength(1);
  });

  it("counts a view turned into a table from zero", async () => {
    const base = model({ name: "t", type: "view", query: "q" });
    const head = model({ name: "t", query: "q" });
    const runner = new FakeDryRunner([["q", { bytes: BYTES_PER_TIB }]]);
    const e = await estimateChange(
      { kind: "modified", target: base.target, base, head },
      runner,
      config,
    );
    expect(e).toMatchObject({ status: "estimated", baseBytes: 0, monthlyDelta: 187.5 });
  });

  it("reports a failed dry run plainly instead of guessing", async () => {
    const m = model({ name: "t" });
    const runner = new FakeDryRunner([], {
      error: "Not found: Table proj:analytics.upstream",
      errorKind: "not-found",
    });
    const e = await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(e).toMatchObject({
      status: "unestimable",
      reason:
        "Dry run at head failed: a table or dataset it reads was not found. BigQuery's message is in the job log.",
      errorKind: "not-found",
      detail: "Not found: Table proj:analytics.upstream",
    });
  });
});

describe("buildReport", () => {
  const est = (monthlyDelta: number): Estimate => ({
    status: "estimated",
    target: "t",
    name: "t",
    kind: "modified",
    type: "table",
    baseBytes: 0,
    headBytes: 0,
    runsPerDay: 1,
    pricePerTib: 6.25,
    monthlyDelta,
  });
  const skipped: Estimate = {
    status: "skipped",
    target: "v",
    name: "v",
    kind: "added",
    type: "view",
    reason: "r",
  };

  it("sums only estimated models", () => {
    expect(buildReport([est(60), est(-10), skipped], config).totalMonthlyDelta).toBe(50);
  });

  it("flags totals over the limit", () => {
    expect(buildReport([est(60), est(50)], config).overLimit).toBe(true);
    expect(buildReport([est(60)], config).overLimit).toBe(false);
  });
});

describe("estimateChanges", () => {
  it("returns an empty, passing report when nothing changed", async () => {
    const report = await estimateChanges([], new FakeDryRunner(), config);
    expect(report).toMatchObject({ estimates: [], totalMonthlyDelta: 0, overLimit: false });
  });
});

describe("partitionFilterCause", () => {
  const GiB = 2 ** 30;
  const T = "proj.raw.events";
  const side = (bytes: number, tables: string[] = [T]) => ({ bytes, partitionedTables: tables });

  it("flags a large jump on a partitioned table both sides read", () => {
    expect(partitionFilterCause(side(0.1 * GiB), side(5 * GiB))).toEqual({
      kind: "partition-filter-removed",
      table: T,
    });
  });

  it("needs at least PARTITION_JUMP_RATIO times the bytes", () => {
    const base = 0.5 * GiB;
    expect(partitionFilterCause(side(base), side(base * PARTITION_JUMP_RATIO))).toBeDefined();
    expect(partitionFilterCause(side(base), side(base * PARTITION_JUMP_RATIO - 1))).toBeUndefined();
  });

  it("needs at least PARTITION_JUMP_MIN_BYTES more per run", () => {
    const base = 1024;
    expect(partitionFilterCause(side(base), side(base + PARTITION_JUMP_MIN_BYTES))).toBeDefined();
    expect(
      partitionFilterCause(side(base), side(base + PARTITION_JUMP_MIN_BYTES - 1)),
    ).toBeUndefined();
  });

  it("needs the same partitioned table on both sides", () => {
    expect(partitionFilterCause(side(0.1 * GiB, []), side(5 * GiB))).toBeUndefined();
    expect(
      partitionFilterCause(side(0.1 * GiB), side(5 * GiB, ["proj.raw.other"])),
    ).toBeUndefined();
    expect(partitionFilterCause({ bytes: 0.1 * GiB }, { bytes: 5 * GiB })).toBeUndefined();
  });

  it("never flags a side that read nothing", () => {
    expect(partitionFilterCause(side(0), side(5 * GiB))).toBeUndefined();
  });

  it("is set on the estimate by estimateChange", async () => {
    const base = model({ name: "t", query: "old" });
    const head = model({ name: "t", query: "new" });
    const runner = new FakeDryRunner([
      ["old", side(0.1 * GiB)],
      ["new", side(5 * GiB)],
    ]);
    const e = await estimateChange(
      { kind: "modified", target: base.target, base, head },
      runner,
      config,
    );
    expect(e).toMatchObject({ likelyCause: { kind: "partition-filter-removed", table: T } });
  });
});

describe("new upstream tables", () => {
  const upstream = model({ name: "new_source", target: "proj.analytics.new_source" });
  const reader = model({
    name: "reader",
    query: "SELECT * FROM `proj.analytics.new_source`",
  });
  const runner = new FakeDryRunner([[upstream.query, { bytes: 1024 }]], {
    error: "Not found: Table proj:analytics.new_source was not found in location US",
    errorKind: "not-found",
  });

  it("reports a model reading a table the same PR adds plainly", async () => {
    const report = await estimateChanges(
      [
        { kind: "added", target: upstream.target, head: upstream },
        { kind: "added", target: reader.target, head: reader },
      ],
      runner,
      config,
    );
    expect(report.estimates.find((e) => e.name === "reader")).toMatchObject({
      status: "unestimable",
      newUpstream: "proj.analytics.new_source",
      reason:
        "Reads `proj.analytics.new_source`, which this pull request creates, so it can only be estimated once that table exists.",
    });
    expect(report.estimates.find((e) => e.name === "new_source")).toMatchObject({
      status: "estimated",
    });
  });

  it("reports the failure kind when the query reads no new table", async () => {
    const e = await estimateChange(
      { kind: "added", target: reader.target, head: reader },
      runner,
      config,
      new Set(["proj.analytics.other"]),
    );
    expect(e).toMatchObject({
      status: "unestimable",
      reason:
        "Dry run at head failed: a table or dataset it reads was not found. BigQuery's message is in the job log.",
      detail: "Not found: Table proj:analytics.new_source was not found in location US",
    });
    expect(e).not.toHaveProperty("newUpstream");
  });

  it("matches only quoted, whole targets and never the model's own", () => {
    const targets = new Set(["p.d.t", "p.d.self"]);
    expect(readsNewTarget("SELECT * FROM `p.d.t`", "p.d.x", targets)).toBe("p.d.t");
    expect(readsNewTarget("SELECT * FROM `p.d.t_old`", "p.d.x", targets)).toBeUndefined();
    expect(readsNewTarget("SELECT * FROM `p.d.self`", "p.d.self", targets)).toBeUndefined();
  });
});

describe("region pricing", () => {
  it("prices a model at its location's price", async () => {
    const base = model({ name: "t", query: "old", location: "asia-northeast1" });
    const head = model({ name: "t", query: "new", location: "asia-northeast1" });
    const runner = new FakeDryRunner([
      ["old", { bytes: 0 }],
      ["new", { bytes: BYTES_PER_TIB }],
    ]);
    const e = await estimateChange({ kind: "modified", target: base.target, base, head }, runner, {
      ...config,
      pricePerTibByLocation: { "asia-northeast1": 10 },
    });
    expect(e).toMatchObject({ monthlyDelta: 300 });
  });
});

describe("limitCannotApply", () => {
  const priced = (pricePerTib: number): Estimate => ({
    status: "estimated",
    target: "t",
    name: "t",
    kind: "modified",
    type: "table",
    baseBytes: 0,
    headBytes: 1024,
    runsPerDay: 1,
    pricePerTib,
    monthlyDelta: 0,
  });
  const at = (estimates: Estimate[], limitMonthly: number | null) =>
    buildReport(estimates, { ...config, limitMonthly });

  it("is true only when a limit is set and every estimated model is priced at 0", () => {
    expect(limitCannotApply(at([priced(0)], 100))).toBe(true);
    expect(limitCannotApply(at([priced(0), priced(6.25)], 100))).toBe(false);
    expect(limitCannotApply(at([priced(0)], null))).toBe(false);
    expect(limitCannotApply(at([], 100))).toBe(false);
  });

  it("carries the model's price on the estimate", async () => {
    const m = model({ name: "t", query: "q", location: "EU" });
    const e = await estimateChange(
      { kind: "added", target: m.target, head: m },
      new FakeDryRunner([["q", { bytes: BYTES_PER_TIB }]]),
      { ...config, pricePerTibByLocation: { eu: 0 } },
    );
    expect(e).toMatchObject({ status: "estimated", pricePerTib: 0, monthlyDelta: 0 });
  });
});

describe("assertions", () => {
  it("estimates an assertion like a table: it scans its inputs on every run", async () => {
    const a = model({ name: "orders_unique", type: "assertion", query: "aq" });
    const e = await estimateChange(
      { kind: "added", target: a.target, head: a },
      new FakeDryRunner([["aq", { bytes: BYTES_PER_TIB }]]),
      config,
    );
    expect(e).toMatchObject({ status: "estimated", type: "assertion", headBytes: BYTES_PER_TIB });
  });
});
