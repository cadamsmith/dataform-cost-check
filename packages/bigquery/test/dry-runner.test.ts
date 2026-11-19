import { describe, expect, it } from "vitest";
import { BigQueryDryRunner } from "../src/index.ts";

describe("BigQueryDryRunner", () => {
  // Failing by design until milestone 1: needs the real implementation and an API mock
  // (or an opt-in integration run with credentials).
  it.skip("returns totalBytesProcessed from a dry-run job", async () => {
    const runner = new BigQueryDryRunner({ projectId: "test-project" });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({ bytes: 0 });
  });

  it("rejects until implemented", async () => {
    const runner = new BigQueryDryRunner({ projectId: "test-project" });
    await expect(runner.estimate("SELECT 1", "US")).rejects.toThrow(/not implemented/);
  });
});
