import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DataformCliNotFoundError, compileProject, loadModels } from "../src/index.ts";

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
