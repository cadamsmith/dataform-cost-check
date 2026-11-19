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
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      bytes: 1048576,
      partitionedTables: [],
    });
  });

  it("falls back to the query statistics", async () => {
    const { runner } = runnerReturning(200, {
      statistics: { query: { totalBytesProcessed: "42" } },
    });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      bytes: 42,
      partitionedTables: [],
    });
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

  it("throws when rate limited", async () => {
    const { runner } = runnerReturning(429, { error: { message: "Too many requests" } });
    await expect(runner.estimate("SELECT 1", "US")).rejects.toThrow(/Too many requests/);
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

  describe("partitioned tables", () => {
    const ref = (tableId: string) => ({ projectId: "p", datasetId: "raw", tableId });

    /** Dry runs read `tables`; tables.get answers from `meta` (status 404 when missing). */
    function runnerWith(tables: object[], meta: Record<string, unknown>) {
      const urls: string[] = [];
      const runner = new BigQueryDryRunner({
        projectId: "test-project",
        getAccessToken: () => Promise.resolve("token-123"),
        fetch: (url) => {
          const u = url instanceof Request ? url.url : url.toString();
          urls.push(u);
          if (u.endsWith("/jobs")) {
            return Promise.resolve(
              Response.json({
                statistics: { query: { totalBytesProcessed: "10", referencedTables: tables } },
              }),
            );
          }
          const table = /tables\/([^?]+)/.exec(u)?.[1] ?? "";
          const body = meta[table];
          if (body === "throw") return Promise.reject(new Error("network down"));
          return Promise.resolve(
            body === undefined ? new Response("", { status: 404 }) : Response.json(body),
          );
        },
      });
      return { runner, urls };
    }

    it("lists referenced tables with time or range partitioning", async () => {
      const { runner, urls } = runnerWith([ref("events"), ref("ranges"), ref("plain")], {
        events: { timePartitioning: { type: "DAY" } },
        ranges: { rangePartitioning: { field: "id" } },
        plain: {},
      });
      await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
        bytes: 10,
        partitionedTables: ["p.raw.events", "p.raw.ranges"],
      });
      expect(urls).toContain(
        "https://bigquery.googleapis.com/bigquery/v2/projects/p/datasets/raw/tables/events?fields=timePartitioning,rangePartitioning",
      );
    });

    it("leaves out tables it cannot look up, without failing the estimate", async () => {
      const { runner } = runnerWith([ref("events"), ref("gone"), ref("broken")], {
        events: { timePartitioning: { type: "DAY" } },
        broken: "throw",
      });
      await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
        bytes: 10,
        partitionedTables: ["p.raw.events"],
      });
    });

    it("skips wildcard tables and looks each table up once", async () => {
      const { runner, urls } = runnerWith([ref("events"), ref("events_*")], {
        events: { timePartitioning: { type: "DAY" } },
      });
      await Promise.all([runner.estimate("SELECT 1", "US"), runner.estimate("SELECT 2", "US")]);
      expect(urls.filter((u) => u.includes("/tables/"))).toHaveLength(1);
    });
  });
});
