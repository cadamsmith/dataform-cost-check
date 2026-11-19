import { describe, expect, it } from "vitest";
import { diffModels } from "../src/index.ts";
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
