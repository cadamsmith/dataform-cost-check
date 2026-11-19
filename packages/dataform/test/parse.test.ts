import { describe, expect, it } from "vitest";
import { parseCompileOutput } from "../src/index.ts";

describe("parseCompileOutput", () => {
  // Failing by design until milestone 1: un-skip once the parser exists, and replace the
  // input with real `dataform compile --json` output from fixtures/sample-project.
  it.skip("maps the sample project's table, incremental and view", () => {
    const models = parseCompileOutput({ tables: [] });
    expect(models.map((m) => m.type).sort()).toEqual(["incremental", "table", "view"]);
  });

  it("throws until implemented", () => {
    expect(() => parseCompileOutput({})).toThrow(/not implemented/);
  });
});
