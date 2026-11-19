import { describe, expect, it } from "vitest";
import { BigQueryDryRunner } from "../src/index.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A runner whose `fetch` answers every request with `status` and `body`, and records it. */
function runnerReturning(status: number, body: unknown) {
  const calls: Call[] = [];
  const runner = new BigQueryDryRunner({
    projectId: "test-project",
    getAccessToken: () => Promise.resolve("token-123"),
    fetch: (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
      return Promise.resolve(Response.json(body, { status }));
    },
  });
  return { runner, calls };
}

function sentBody(call: Call | undefined): unknown {
  return JSON.parse(call?.init.body as string);
}

describe("BigQueryDryRunner", () => {
  it("returns totalBytesProcessed from a dry-run job", async () => {
    const { runner } = runnerReturning(200, { statistics: { totalBytesProcessed: "1048576" } });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({ bytes: 1048576 });
  });

  it("falls back to the query statistics", async () => {
    const { runner } = runnerReturning(200, {
      statistics: { query: { totalBytesProcessed: "42" } },
    });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({ bytes: 42 });
  });

  it("sends a standard-SQL dry run in the given location", async () => {
    const { runner, calls } = runnerReturning(200, { statistics: { totalBytesProcessed: "0" } });
    await runner.estimate("SELECT 1", "europe-west2");
    expect(calls[0]?.url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/test-project/jobs",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-123");
    expect(sentBody(calls[0])).toEqual({
      configuration: { dryRun: true, query: { query: "SELECT 1", useLegacySql: false } },
      jobReference: { projectId: "test-project", location: "europe-west2" },
    });
  });

  it("sends no location when the model has none", async () => {
    const { runner, calls } = runnerReturning(200, { statistics: { totalBytesProcessed: "0" } });
    await runner.estimate("SELECT 1", undefined);
    expect(sentBody(calls[0])).not.toHaveProperty("jobReference");
  });

  it("reports a query error as not estimable", async () => {
    const message = "Not found: Dataset test-project:raw was not found in location US";
    const { runner } = runnerReturning(404, { error: { code: 404, message } });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({ error: message });
  });

  it("reports missing table access as not estimable", async () => {
    const message = "Access Denied: Table test-project:raw.orders";
    const { runner } = runnerReturning(403, { error: { code: 403, message } });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({ error: message });
  });

  it("throws on bad credentials, which would fail every model", async () => {
    const { runner } = runnerReturning(401, { error: { message: "Invalid credentials" } });
    await expect(runner.estimate("SELECT 1", "US")).rejects.toThrow(/Invalid credentials/);
  });

  it("throws when BigQuery is unavailable", async () => {
    const { runner } = runnerReturning(503, {});
    await expect(runner.estimate("SELECT 1", "US")).rejects.toThrow(/HTTP 503/);
  });

  it("reports a response without a byte count as not estimable", async () => {
    const { runner } = runnerReturning(200, { statistics: {} });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      error: "BigQuery returned no bytes-processed figure for the dry run.",
    });
  });
});
