import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataformCliNotFoundError,
  DataformDependenciesMissingError,
  compileArgs,
  compileProject,
  isDataformProject,
  loadModels,
} from "../src/index.ts";

/** The nightly canary points this at a copy whose core version matches the CLI under test. */
const projectDir =
  process.env.DATAFORM_SAMPLE_PROJECT ??
  fileURLToPath(new URL("../../../fixtures/sample-project", import.meta.url));

function hasDataformCli(): boolean {
  try {
    execFileSync("dataform", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("compileProject", () => {
  it("reports a missing CLI distinctly", async () => {
    await expect(
      compileProject({ projectDir, command: "dataform-cli-that-does-not-exist" }),
    ).rejects.toThrow(DataformCliNotFoundError);
  });

  it("says the project directory is missing, rather than the CLI", async () => {
    const missing = join(tmpdir(), "dcc-no-such-project");
    await expect(compileProject({ projectDir: missing })).rejects.toThrow(
      `No Dataform project at ${missing}: the directory does not exist.`,
    );
  });

  it("asks for an install when a package.json project has no node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dcc-pkg-"));
    writeFileSync(join(dir, "package.json"), "{}");
    await expect(compileProject({ projectDir: dir })).rejects.toThrow(
      DataformDependenciesMissingError,
    );
  });

  // Runs only where the Dataform CLI is installed; the parser tests use a saved copy.
  it.skipIf(!hasDataformCli())("compiles and loads the sample project", async () => {
    const models = await loadModels({ projectDir });
    expect(models.map((m) => m.name).sort()).toEqual([
      "active_customer_orders",
      "customers",
      "customers_unique",
      "drop_stale_orders",
      "grant_readers",
      "orders_by_customer",
      "orders_daily",
      "orders_recent",
    ]);
  });

  // Release-config overrides, applied by the real CLI: every target, ref() and self() moves
  // to production, declared sources stay put, and names stay as written for runs_per_day.
  it.skipIf(!hasDataformCli())("compiles with release-config overrides", async () => {
    const models = await loadModels({
      projectDir,
      overrides: {
        defaultDatabase: "prod-proj",
        schemaSuffix: "prod",
        tablePrefix: "rel",
        defaultLocation: "EU",
      },
    });
    const daily = models.find((m) => m.name === "orders_daily");
    expect(daily?.target).toBe("prod-proj.analytics_prod.rel_orders_daily");
    expect(daily?.location).toBe("EU");
    expect(daily?.incrementalQuery).toContain("FROM `cost-check-sample.raw.orders`");
    expect(daily?.incrementalQuery).toContain("FROM `prod-proj.analytics_prod.rel_orders_daily`");
    expect(models.find((m) => m.name === "customers_unique")?.target).toBe(
      "prod-proj.analytics_assertions_prod.rel_customers_unique",
    );
    expect(models.find((m) => m.name === "grant_readers")?.query).toContain(
      "`prod-proj.analytics_prod.rel_customers`",
    );
  });
});

describe("compileArgs", () => {
  it("compiles with workflow_settings.yaml alone by default", () => {
    expect(compileArgs()).toEqual(["compile", "--json"]);
  });

  it("passes release-config overrides to the CLI, skipping empty ones", () => {
    expect(
      compileArgs({ defaultDatabase: "prod-proj", schemaSuffix: "", vars: "env=prod,days=7" }),
    ).toEqual(["compile", "--json", "--default-database=prod-proj", "--vars=env=prod,days=7"]);
  });
});

/**
 * Dataform 2.x, compiled for real by the 2.x CLI. Runs only in the nightly canary, which
 * installs that CLI and the fixture's dependencies and sets DATAFORM_V2_CLI to its path.
 */
const v2Cli = process.env.DATAFORM_V2_CLI;
describe.skipIf(v2Cli === undefined)("Dataform 2.x CLI", () => {
  it("compiles and loads a dataform.json project", async () => {
    const models = await loadModels({
      projectDir: fileURLToPath(new URL("../../../fixtures/v2-project", import.meta.url)),
      command: v2Cli ?? "dataform",
    });
    expect(models.map((m) => [m.name, m.type]).sort()).toEqual([
      ["orders", "incremental"],
      ["totals", "table"],
    ]);
    expect(models.find((m) => m.name === "orders")?.incrementalPreOps?.[0]).toContain("DECLARE");
  });
});

describe("isDataformProject", () => {
  it("finds workflow_settings.yaml or a legacy dataform.json", () => {
    expect(isDataformProject(projectDir)).toBe(true);
    const legacy = mkdtempSync(join(tmpdir(), "dcc-legacy-"));
    writeFileSync(join(legacy, "dataform.json"), "{}");
    expect(isDataformProject(legacy)).toBe(true);
  });

  it("is false for an empty or missing directory, as at a base from before the project", () => {
    expect(isDataformProject(mkdtempSync(join(tmpdir(), "dcc-empty-")))).toBe(false);
    expect(isDataformProject(join(tmpdir(), "dcc-no-such-project"))).toBe(false);
  });
});
