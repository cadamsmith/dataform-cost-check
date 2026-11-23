import { describe, expect, it } from "vitest";
import { BigQueryDryRunner, classifyError } from "../src/index.ts";

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
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      error: message,
      errorKind: "not-found",
    });
  });

  it("reports missing table access as not estimable", async () => {
    const message = "Access Denied: Table test-project:raw.orders";
    const { runner } = runnerReturning(403, { error: { code: 403, message } });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      error: message,
      errorKind: "permission-denied",
    });
  });

  it("keeps BigQuery's message as detail and sorts it into a kind", async () => {
    const message = "Syntax error: Unclosed string literal 'secret-customer-id' at [1:8]";
    const { runner } = runnerReturning(400, {
      error: { code: 400, message, errors: [{ reason: "invalidQuery", message }] },
    });
    await expect(runner.estimate("SELECT 1", "US")).resolves.toEqual({
      error: message,
      errorKind: "query-error",
    });
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
      errorKind: "unknown",
    });
  });

  describe("classifyError", () => {
    it("names a disabled API", () => {
      expect(
        classifyError(403, {
          message: "BigQuery API has not been used in project 1 before or it is disabled.",
          errors: [{ reason: "accessNotConfigured" }],
        }),
      ).toBe("api-disabled");
      expect(classifyError(403, { details: [{ reason: "SERVICE_DISABLED" }] })).toBe(
        "api-disabled",
      );
    });

    it("names a missing required partition filter", () => {
      expect(
        classifyError(400, {
          message:
            "Cannot query over table 'p.d.events' without a filter over column(s) 'day' that can be used for partition elimination",
          errors: [{ reason: "invalidQuery" }],
        }),
      ).toBe("partition-filter-required");
    });

    it("falls back on the status", () => {
      expect(classifyError(404, undefined)).toBe("not-found");
      expect(classifyError(403, undefined)).toBe("permission-denied");
      expect(classifyError(400, undefined)).toBe("query-error");
      expect(classifyError(409, undefined)).toBe("unknown");
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

  describe("table", () => {
    function runnerAnswering(status: number, body: unknown) {
      const { runner, calls } = runnerReturning(status, body);
      return { runner, urls: () => calls.map((c) => c.url) };
    }
    const meta = {
      type: "TABLE",
      numBytes: "2448008668",
      schema: { fields: [{ name: "refresh_date" }, { name: "term" }] },
    };

    it("returns the columns and logical size from tables.get", async () => {
      const { runner, urls } = runnerAnswering(200, meta);
      await expect(runner.table("p.raw.events")).resolves.toEqual({
        columns: ["refresh_date", "term"],
        bytes: 2448008668,
      });
      expect(urls()).toEqual([
        "https://bigquery.googleapis.com/bigquery/v2/projects/p/datasets/raw/tables/events?fields=type,numBytes,schema/fields/name",
      ]);
    });

    it("keeps a domain-scoped project whole, and defaults a missing one", async () => {
      const scoped = runnerAnswering(200, meta);
      await scoped.runner.table("example.com:proj.raw.events");
      expect(scoped.urls()[0]).toContain("/projects/example.com%3Aproj/datasets/raw/tables/events");
      const bare = runnerAnswering(200, meta);
      await bare.runner.table("raw.events");
      expect(bare.urls()[0]).toContain("/projects/test-project/datasets/raw/tables/events");
    });

    it("is undefined for a missing table, a view, or a broken answer", async () => {
      await expect(runnerAnswering(404, {}).runner.table("p.raw.gone")).resolves.toBeUndefined();
      await expect(
        runnerAnswering(200, { ...meta, type: "VIEW" }).runner.table("p.raw.v"),
      ).resolves.toBeUndefined();
      await expect(
        runnerAnswering(200, { type: "TABLE", schema: meta.schema }).runner.table("p.raw.t"),
      ).resolves.toBeUndefined();
      await expect(runnerAnswering(403, {}).runner.table("p.raw.secret")).resolves.toBeUndefined();
    });
  });
});
