import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DataformCompilationError, parseCompileOutput } from "../src/index.ts";

/** Real `dataform compile --json` output (CLI 3.0.61) from fixtures/sample-project. */
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
      ["cost-check-sample.analytics.customers", "table"],
      ["cost-check-sample.analytics.orders_daily", "incremental"],
      ["cost-check-sample.analytics.orders_recent", "view"],
      ["cost-check-sample.analytics_assertions.customers_unique", "assertion"],
      ["cost-check-sample.analytics.grant_readers", "operations"],
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

  it("joins an operation's statements into one script", () => {
    const input = sampleWith((o) => {
      (o.operations?.[0] as { queries: string[] }).queries = ["SELECT 1", "SELECT 2"];
    });
    const op = parseCompileOutput(input).find((m) => m.type === "operations");
    expect(op?.query).toBe("SELECT 1;\nSELECT 2");
  });

  it("leaves out disabled actions", () => {
    const input = sampleWith((o) => {
      (o.tables?.[0] as { disabled: boolean }).disabled = true;
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

  it("rejects output that is not a compile result", () => {
    expect(() => parseCompileOutput(null)).toThrow(/not a JSON object/);
    expect(() => parseCompileOutput({ tables: [] })).toThrow(/defaultLocation/);
  });
});
