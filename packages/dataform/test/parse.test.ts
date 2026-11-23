import { readFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  FakeDryRunner,
  estimateChange,
  runsPerDayFor,
} from "@dataform-cost-check/core";
import type { Model } from "@dataform-cost-check/core";
import { describe, expect, it } from "vitest";
import { DataformCompilationError, parseCliJson, parseCompileOutput } from "../src/index.ts";

/** Real `dataform compile --json` output (CLI and core 3.1.6) from fixtures/sample-project. */
const sample: unknown = JSON.parse(
  readFileSync(new URL("fixtures/sample-compile.json", import.meta.url), "utf8"),
);

/** A deep copy of the sample, edited by `edit`. */
function sampleWith(edit: (output: Record<string, unknown[]>) => void): unknown {
  const copy = structuredClone(sample) as Record<string, unknown[]>;
  edit(copy);
  return copy;
}

describe("parseCompileOutput", () => {
  it("maps the sample project's tables, assertion and operation", () => {
    const models = parseCompileOutput(sample);
    expect(models.map((m) => [m.target, m.type])).toEqual([
      ["cost-check-sample.analytics.active_customer_orders", "table"],
      ["cost-check-sample.analytics.customers", "table"],
      ["cost-check-sample.analytics.orders_by_customer", "incremental"],
      ["cost-check-sample.analytics.orders_daily", "incremental"],
      ["cost-check-sample.analytics.orders_recent", "view"],
      ["cost-check-sample.analytics_assertions.customers_unique", "assertion"],
      ["cost-check-sample.analytics.grant_readers", "operations"],
      ["cost-check-sample.analytics.drop_stale_orders", "operations"],
    ]);
  });

  it("leaves out declarations", () => {
    const targets = parseCompileOutput(sample).map((m) => m.target);
    expect(targets).not.toContain("cost-check-sample.raw.orders");
  });

  it("keeps both queries of an incremental model", () => {
    const daily = parseCompileOutput(sample).find((m) => m.name === "orders_daily");
    expect(daily?.query).not.toMatch(/WHERE/);
    expect(daily?.incrementalQuery).toMatch(/WHERE order_date >= \(SELECT MAX\(order_date\)/);
  });

  it("carries tags, defaulting to none", () => {
    const models = parseCompileOutput(sample);
    expect(models.find((m) => m.name === "customers")?.tags).toEqual(["daily"]);
    expect(models.find((m) => m.name === "orders_recent")?.tags).toEqual([]);
  });

  it("uses the project's default location for every model", () => {
    expect(new Set(parseCompileOutput(sample).map((m) => m.location))).toEqual(new Set(["US"]));
  });

  it("leaves the location unset when the project has no default", () => {
    const input = sampleWith((o) => {
      delete (o as { projectConfig?: { defaultLocation?: string } }).projectConfig?.defaultLocation;
    });
    expect(parseCompileOutput(input).every((m) => !("location" in m))).toBe(true);
  });

  it("joins an operation's statements into one script", () => {
    const input = sampleWith((o) => {
      (o.operations?.[0] as { queries: string[] }).queries = ["SELECT 1", "SELECT 2"];
    });
    const op = parseCompileOutput(input).find((m) => m.type === "operations");
    expect(op?.query).toBe("SELECT 1;\nSELECT 2");
  });

  it("leaves out disabled actions", () => {
    const input = sampleWith((o) => {
      const customers = (o.tables as { target: { name: string }; disabled: boolean }[]).find(
        (t) => t.target.name === "customers",
      );
      if (customers) customers.disabled = true;
    });
    expect(parseCompileOutput(input).map((m) => m.name)).not.toContain("customers");
  });

  it("throws on compilation errors instead of returning a partial graph", () => {
    const input = {
      ...(sample as object),
      graphErrors: {
        compilationErrors: [
          { fileName: "definitions/customers.sqlx", message: 'Unexpected property "location"' },
        ],
      },
    };
    expect(() => parseCompileOutput(input)).toThrow(DataformCompilationError);
    expect(() => parseCompileOutput(input)).toThrow(
      'definitions/customers.sqlx: Unexpected property "location"',
    );
  });

  it("names a model as written in the project when a table prefix renames its target", () => {
    const input = sampleWith((o) => {
      const t = (o.tables as { name?: string; target: { name: string } }[]).find(
        (x) => x.target.name === "orders_daily",
      );
      if (t === undefined) throw new Error("sample has no orders_daily");
      t.target.name = "rel_orders_daily";
    });
    const daily = parseCompileOutput(input).find((m) => m.target.endsWith(".rel_orders_daily"));
    expect(daily?.name).toBe("orders_daily");
    const config = { ...DEFAULT_CONFIG, runsPerDay: { orders_daily: 24 } };
    expect(daily && runsPerDayFor(daily, config)).toBe(24);
  });

  it("falls back to the target's name when there is no canonical target", () => {
    const input = sampleWith((o) => {
      for (const t of o.tables as { canonicalTarget?: unknown }[]) delete t.canonicalTarget;
    });
    expect(parseCompileOutput(input).map((m) => m.name)).toContain("orders_daily");
  });

  it("rejects output that is not a compile result", () => {
    expect(() => parseCompileOutput(null)).toThrow(/not a JSON object/);
  });
});

/**
 * Real `dataform compile --json` output (CLI and core 3.0.61) from a project shaped like
 * a team's: actions defined in JavaScript (`publish` in a loop, `assert`, `declare`), an
 * `includes/` helper, a `package.json`, and an incremental with a pre-operations checkpoint.
 */
const jsProject: unknown = JSON.parse(
  readFileSync(new URL("fixtures/js-compile.json", import.meta.url), "utf8"),
);

describe("parseCompileOutput on JavaScript-defined actions", () => {
  it("maps tables from a publish() loop, a JS assertion and an SQLX incremental", () => {
    const models = parseCompileOutput(jsProject);
    expect(models.map((m) => [m.name, m.type]).sort()).toEqual([
      ["terms_daily", "incremental"],
      ["top_rising_terms_yesterday", "table"],
      ["top_terms_have_rank", "assertion"],
      ["top_terms_yesterday", "table"],
    ]);
  });

  it("expands includes/ helpers into the compiled SQL", () => {
    const table = parseCompileOutput(jsProject).find((m) => m.name === "top_terms_yesterday");
    expect(table?.query).toContain("DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)");
    expect(table?.tags).toEqual(["hourly"]);
  });

  it("keeps both kinds of pre-operations on an incremental model", () => {
    const inc = parseCompileOutput(jsProject).find((m) => m.name === "terms_daily");
    expect(inc?.preOps?.[0]).toContain("DECLARE checkpoint");
    expect(inc?.incrementalPreOps?.[0]).toContain("SELECT MAX(refresh_date)");
  });
});

describe("JavaScript-defined actions in the sample project", () => {
  const models = parseCompileOutput(sample);
  const find = (name: string): Model => {
    const model = models.find((m) => m.name === name);
    if (model === undefined) throw new Error(`sample has no ${name}`);
    return model;
  };
  const modified = (model: Model) => ({
    kind: "modified" as const,
    target: model.target,
    base: { ...model, incrementalQuery: `${model.incrementalQuery ?? ""}\n-- base` },
    head: model,
  });

  it("splits a publish().preOps() checkpoint into full-refresh and incremental pre-operations", () => {
    const inc = find("orders_by_customer");
    expect(inc.type).toBe("incremental");
    expect(inc.preOps?.[0]).toContain("SELECT DATE '2000-01-01'");
    expect(inc.incrementalPreOps?.[0]).toContain(
      "SELECT MAX(order_date) FROM `cost-check-sample.analytics.orders_by_customer`",
    );
    expect(inc.incrementalQuery).toContain("WHERE order_date > checkpoint");
    expect(inc.query).not.toContain("checkpoint");
  });

  it("reports the checkpoint incremental as not estimated, naming the variable, dry-running only its full refresh", async () => {
    const runner = new FakeDryRunner();
    const estimate = await estimateChange(
      modified(find("orders_by_customer")),
      runner,
      DEFAULT_CONFIG,
    );
    expect(estimate).toMatchObject({ status: "unestimable", preOpsVariable: "checkpoint" });
    // The incremental query (which needs the checkpoint) is never dry-run; the full
    // refresh, which declares no checkpoint, is.
    const inc = find("orders_by_customer");
    expect(runner.calls.map((c) => c.sql)).toEqual([inc.query, inc.query]);
  });

  it("skips an operate() action like an SQLX operation", async () => {
    const op = find("drop_stale_orders");
    expect(op.type).toBe("operations");
    expect(op.query).toContain("DELETE FROM `cost-check-sample.analytics.orders_by_customer`");
    const runner = new FakeDryRunner();
    const estimate = await estimateChange(
      { kind: "added", target: op.target, head: op },
      runner,
      DEFAULT_CONFIG,
    );
    expect(estimate.status).toBe("skipped");
    expect(runner.calls).toEqual([]);
  });
});

describe("parseCompileOutput on incremental models with a unique key", () => {
  const withKey = (bigquery?: object) =>
    sampleWith((o) => {
      const t = (o.tables as Record<string, unknown>[]).find((x) => x.type === "incremental");
      if (t === undefined) throw new Error("sample has no incremental");
      t.uniqueKey = ["order_id"];
      if (bigquery !== undefined) t.bigquery = bigquery;
    });

  it("marks the model as a MERGE, with its key and update filter", () => {
    const inc = (out: unknown) => parseCompileOutput(out).find((m) => m.type === "incremental");
    expect(inc(withKey())?.merge).toEqual({ uniqueKey: ["order_id"] });
    expect(inc(withKey({ updatePartitionFilter: "day > '2026-01-01'" }))?.merge).toEqual({
      uniqueKey: ["order_id"],
      updatePartitionFilter: "day > '2026-01-01'",
    });
    expect(
      inc(withKey({ incrementalPredicates: ["DATAFORM_DEST.day > '2026-01-01'"] }))?.merge,
    ).toEqual({
      uniqueKey: ["order_id"],
      incrementalPredicates: ["DATAFORM_DEST.day > '2026-01-01'"],
    });
    const overwrite = sampleWith((o) => {
      const t = (o.tables as Record<string, unknown>[]).find((x) => x.type === "incremental");
      if (t === undefined) throw new Error("sample has no incremental");
      t.uniqueKey = ["order_id"];
      t.incrementalStrategy = "INSERT_OVERWRITE";
    });
    expect(inc(overwrite)?.merge).toBeUndefined();
    expect(inc(overwrite)?.insertOverwrite).toBe(true);
    expect(inc(withKey())?.insertOverwrite).toBeUndefined();
    const noKey = sampleWith((o) => {
      for (const t of o.tables as Record<string, unknown>[]) delete t.uniqueKey;
    });
    expect(inc(noKey)?.merge).toBeUndefined();
  });
});

describe("Dataform 2.x", () => {
  /** Real stdout of `dataform compile --json` from CLI and core 2.9.0 (a dataform.json project). */
  const stdout = readFileSync(new URL("fixtures/v2-cli-stdout.txt", import.meta.url), "utf8");

  it("skips the log line the 2.x CLI prints before the JSON", () => {
    expect(stdout.startsWith('{"level":"INFO"')).toBe(true);
    const models = parseCompileOutput(parseCliJson(stdout));
    expect(models.map((m) => [m.name, m.type]).sort()).toEqual([
      ["js_table", "table"],
      ["orders", "incremental"],
    ]);
    const orders = models.find((m) => m.name === "orders");
    expect(orders?.location).toBe("US");
    expect(orders?.incrementalPreOps?.[0]).toContain("DECLARE checkpoint");
  });

  it("still rejects output that is not JSON at all", () => {
    expect(() => parseCliJson("Dataform encountered an error")).toThrow();
  });
});

describe("a pre_operations temp table (SQLX)", () => {
  it("keeps the pre-operations and reports the model as not estimated, without a dry run", async () => {
    const model = parseCompileOutput(sample).find((m) => m.name === "active_customer_orders");
    if (model === undefined) throw new Error("active_customer_orders missing from the sample");
    expect(model.preOps?.[0]).toContain("CREATE TEMP TABLE active_scope");
    const runner = new FakeDryRunner();
    const estimate = await estimateChange(
      { kind: "added", target: model.target, head: model },
      runner,
      DEFAULT_CONFIG,
    );
    expect(estimate).toMatchObject({ status: "unestimable", preOpsTempTable: "active_scope" });
    expect(runner.calls).toEqual([]);
  });
});

/**
 * Real `dataform compile --json` output (CLI and core 3.1.6) from a project with
 * just-in-time actions: `.jitCode()` on a table, an incremental, a view and an operation in
 * JavaScript, a `compilation_mode: "jit"` SQLX table, and one ordinary SQLX table. JIT
 * actions carry `jitCode` and no `query` or `queries`.
 */
const jitProject: unknown = JSON.parse(
  readFileSync(new URL("fixtures/jit-compile.json", import.meta.url), "utf8"),
);

describe("parseCompileOutput on just-in-time actions", () => {
  it("keeps JIT actions as models with their code and no query, beside ordinary ones", () => {
    const models = parseCompileOutput(jitProject);
    expect(models.map((m) => [m.name, m.type, m.jitCode !== undefined]).sort()).toEqual([
      ["orders", "table", false],
      ["orders_jit", "table", true],
      ["orders_jit_incremental", "incremental", true],
      ["orders_jit_view", "view", true],
      ["orders_sqlx_jit", "table", true],
      ["refresh_jit", "operations", true],
    ]);
    const jit = models.find((m) => m.name === "orders_jit");
    expect(jit?.query).toBe("");
    expect(jit?.jitCode).toContain("jctx");
    expect(models.find((m) => m.name === "orders")?.query).toContain("raw.orders");
  });

  it("reports a JIT table as not estimated, without a dry run", async () => {
    const model = parseCompileOutput(jitProject).find((m) => m.name === "orders_sqlx_jit");
    if (model === undefined) throw new Error("orders_sqlx_jit missing from the fixture");
    const runner = new FakeDryRunner();
    const estimate = await estimateChange(
      { kind: "added", target: model.target, head: model },
      runner,
      DEFAULT_CONFIG,
    );
    expect(estimate).toMatchObject({ status: "unestimable", jit: true });
    expect(runner.calls).toEqual([]);
  });

  it("still rejects an ordinary action with no query", () => {
    const broken = structuredClone(jitProject) as { tables: Record<string, unknown>[] };
    const orders = broken.tables.find((t) => (t.target as { name: string }).name === "orders");
    if (orders === undefined) throw new Error("orders missing from the fixture");
    delete orders.query;
    expect(() => parseCompileOutput(broken)).toThrow("has no query");
  });
});
