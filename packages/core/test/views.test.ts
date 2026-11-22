import { describe, expect, it } from "vitest";
import { diffModels, inlineViews, withViewReaders } from "../src/index.ts";
import type { Model } from "../src/index.ts";
import { model } from "./helpers.ts";

const V = "proj.analytics.orders_v";
const defs = new Map([[V, "SELECT * FROM `proj.raw.orders` WHERE day = CURRENT_DATE()"]]);

describe("inlineViews", () => {
  it("adds the view's name as alias when the reference has none", () => {
    expect(inlineViews(`SELECT orders_v.id FROM \`${V}\` WHERE x`, defs)).toBe(
      "SELECT orders_v.id FROM (SELECT * FROM `proj.raw.orders` WHERE day = CURRENT_DATE()) AS orders_v WHERE x",
    );
  });

  it("keeps an existing alias, with or without AS", () => {
    expect(inlineViews(`SELECT o.id FROM \`${V}\` AS o`, defs)).toBe(
      "SELECT o.id FROM (SELECT * FROM `proj.raw.orders` WHERE day = CURRENT_DATE()) AS o",
    );
    expect(inlineViews(`SELECT o.id FROM \`${V}\` o JOIN t`, defs)).toContain(
      "CURRENT_DATE()) o JOIN t",
    );
  });

  it("replaces every reference and leaves other tables alone", () => {
    const sql = `SELECT * FROM \`${V}\` a JOIN \`${V}\` b ON a.id = b.id JOIN \`proj.raw.x\` c`;
    const out = inlineViews(sql, defs);
    expect(out.match(/proj\.raw\.orders/g)).toHaveLength(2);
    expect(out).toContain("`proj.raw.x` c");
    expect(out).not.toContain(`\`${V}\``);
  });
});

describe("withViewReaders", () => {
  const view = (query: string): Model =>
    model({ name: "orders_v", target: V, type: "view", query });
  const reader = model({ name: "daily", query: `SELECT COUNT(*) FROM \`${V}\`` });
  const unrelated = model({ name: "other", query: "SELECT 1" });

  it("re-estimates an unchanged reader of a changed view with each side's definition", () => {
    const base = [
      view("SELECT * FROM `proj.raw.orders` WHERE day = CURRENT_DATE()"),
      reader,
      unrelated,
    ];
    const head = [view("SELECT * FROM `proj.raw.orders`"), reader, unrelated];
    const changes = withViewReaders(diffModels(base, head), base, head);
    const added = changes.find((c) => c.target === reader.target);
    expect(added).toMatchObject({ kind: "modified", viaViews: ["orders_v"] });
    if (added?.kind !== "modified") throw new Error("expected a modified change");
    expect(added.base.query).toContain("WHERE day = CURRENT_DATE()) AS orders_v");
    expect(added.head.query).toBe(
      "SELECT COUNT(*) FROM (SELECT * FROM `proj.raw.orders`) AS orders_v",
    );
    expect(changes.some((c) => c.target === unrelated.target)).toBe(false);
  });

  it("follows unchanged views that read a changed view", () => {
    const outer = model({ name: "outer_v", type: "view", query: `SELECT * FROM \`${V}\`` });
    const top = model({ name: "top", query: `SELECT * FROM \`${outer.target}\`` });
    const base = [view("SELECT 1 AS a"), outer, top];
    const head = [view("SELECT 2 AS a"), outer, top];
    const changes = withViewReaders(diffModels(base, head), base, head);
    const t = changes.find((c) => c.target === top.target);
    expect(t).toMatchObject({ kind: "modified", viaViews: ["outer_v"] });
    if (t?.kind !== "modified") throw new Error("expected a modified change");
    expect(t.head.query).toContain("SELECT 2 AS a");
    expect(t.base.query).toContain("SELECT 1 AS a");
  });

  it("inlines a changed view that reads another changed view, in either order", () => {
    const inner = (sql: string) => model({ name: "inner_v", type: "view", query: sql });
    const outer = (sql: string) =>
      model({
        name: "outer_v",
        type: "view",
        query: `SELECT a, ${sql} FROM \`${inner("").target}\``,
      });
    const top = model({ name: "top", query: `SELECT * FROM \`${outer("").target}\`` });
    const base = [inner("SELECT 1 AS a"), outer("1 AS b"), top];
    for (const head of [
      [inner("SELECT 2 AS a"), outer("2 AS b"), top],
      [outer("2 AS b"), inner("SELECT 2 AS a"), top],
    ]) {
      const t = withViewReaders(diffModels(base, head), base, head).find(
        (c) => c.target === top.target,
      );
      if (t?.kind !== "modified") throw new Error("expected a modified change");
      expect(t.head.query).toContain("SELECT 2 AS a");
      expect(t.head.query).not.toContain("`proj.analytics.inner_v`");
      expect(t.base.query).toContain("SELECT 1 AS a");
      expect(t.base.query).not.toContain("`proj.analytics.inner_v`");
    }
  });

  it("changes nothing when no view changed", () => {
    const base = [reader, unrelated];
    const head = [{ ...reader, query: "SELECT 2" }, unrelated];
    expect(withViewReaders(diffModels(base, head), base, head)).toEqual(diffModels(base, head));
  });
});
