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
