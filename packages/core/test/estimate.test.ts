import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  DEFAULT_CONFIG,
  FakeDryRunner,
  buildReport,
  estimateChange,
  estimateChanges,
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
    const runner = new FakeDryRunner([["incr", { bytes: 10 }]]);
    await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(runner.calls).toEqual([{ sql: "incr", location: "US" }]);
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
    const runner = new FakeDryRunner([], { error: "Not found: Table proj:analytics.upstream" });
    const e = await estimateChange({ kind: "added", target: m.target, head: m }, runner, config);
    expect(e).toMatchObject({
      status: "unestimable",
      reason: "Dry run at head failed: Not found: Table proj:analytics.upstream",
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
