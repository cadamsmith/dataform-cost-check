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
  loadModels,
} from "../src/index.ts";

const projectDir = fileURLToPath(new URL("../../../fixtures/sample-project", import.meta.url));

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
      "customers",
      "customers_unique",
      "grant_readers",
      "orders_daily",
      "orders_recent",
    ]);
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
