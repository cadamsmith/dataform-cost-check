import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, diffModels } from "../src/index.ts";
import { model } from "./helpers.ts";

describe("diffModels", () => {
  const a = model({ name: "a" });
  const b = model({ name: "b" });
  const c = model({ name: "c" });

  it("finds no changes between identical compilations", () => {
    expect(diffModels([a, b], [b, a])).toEqual([]);
  });

  it("reports added, removed and modified models, sorted by target", () => {
    const bChanged = { ...b, query: "SELECT 1" };
    expect(diffModels([a, b], [bChanged, c])).toEqual([
      { kind: "removed", target: a.target, base: a },
      { kind: "modified", target: b.target, base: b, head: bChanged },
      { kind: "added", target: c.target, head: c },
    ]);
  });

  it("treats a changed incremental query as modified", () => {
    const inc = model({ name: "inc", type: "incremental", incrementalQuery: "SELECT 1" });
    const changed = { ...inc, incrementalQuery: "SELECT 2" };
    expect(diffModels([inc], [changed])).toHaveLength(1);
  });

  it("ignores tag changes that leave the SQL alone", () => {
    expect(diffModels([a], [{ ...a, tags: ["hourly"] }])).toEqual([]);
  });

  it("rejects duplicate targets", () => {
    expect(() => diffModels([a, a], [])).toThrow(/Duplicate target in base/);
  });
});

describe("diffModels and pre_operations", () => {
  it("treats a change to pre-operations alone as a modified model", () => {
    const base = model({ name: "inc", preOps: ["DECLARE a INT64 DEFAULT 1;"] });
    const head = { ...base, preOps: ["DECLARE a INT64 DEFAULT 2;"] };
    expect(diffModels([base], [head]).map((c) => c.kind)).toEqual(["modified"]);
    expect(diffModels([base], [{ ...base }])).toEqual([]);
  });
});

describe("diffModels and just-in-time actions", () => {
  it("treats a change to a JIT action's code as a modified model", () => {
    const base = model({ name: "jit", query: "", jitCode: "async (c) => ({ query: 'a' })" });
    const head = { ...base, jitCode: "async (c) => ({ query: 'b' })" };
    expect(diffModels([base], [head]).map((c) => c.kind)).toEqual(["modified"]);
    expect(diffModels([base], [{ ...base }])).toEqual([]);
  });

  it("treats a model switching to JIT compilation as modified", () => {
    const base = model({ name: "t" });
    const head = { ...base, query: "", jitCode: "async (c) => ({ query: 'a' })" };
    expect(diffModels([base], [head]).map((c) => c.kind)).toEqual(["modified"]);
  });
});

describe("diffModels with a config", () => {
  const config = { ...DEFAULT_CONFIG, runsPerDay: { hourly: 24 } };
  const daily = model({ name: "t", tags: ["daily"] });

  it("counts a new tag that changes runs per day as a change", () => {
    const hourly = { ...daily, tags: ["hourly"] };
    expect(diffModels([daily], [hourly])).toEqual([]);
    expect(diffModels([daily], [hourly], config)).toEqual([
      { kind: "modified", target: daily.target, base: daily, head: hourly },
    ]);
  });

  it("ignores a new tag that does not change runs per day", () => {
    expect(diffModels([daily], [{ ...daily, tags: ["nightly"] }], config)).toEqual([]);
  });

  it("counts a location with another price as a change", () => {
    const moved = { ...daily, location: "europe-west2" };
    expect(diffModels([daily], [moved], config)).toHaveLength(1);
  });
});
