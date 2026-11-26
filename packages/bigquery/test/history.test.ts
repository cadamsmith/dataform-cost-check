import { describe, expect, it } from "vitest";
import { jobRebuilt, jobTarget, readRefreshHistory } from "../src/index.ts";

const T = "proj.analytics.orders_daily";

const ctas = {
  configuration: {
    query: {
      destinationTable: { projectId: "proj", datasetId: "analytics", tableId: "orders_daily" },
    },
  },
  statistics: {
    startTime: "1763660000000",
    endTime: "1763660002500",
    totalSlotMs: "7200000",
    totalBytesProcessed: "1067347121",
    query: { statementType: "CREATE_TABLE_AS_SELECT" },
  },
};
const script = {
  configuration: {
    query: {
      query:
        "DECLARE checkpoint DATE; INSERT INTO `proj.analytics.orders_daily` (a) SELECT a FROM src",
    },
  },
  statistics: {
    startTime: "1763660000000",
    endTime: "1763660090000",
    totalSlotMs: "1000",
    totalBytesProcessed: "241456014",
    query: { statementType: "SCRIPT" },
  },
};

function fetchReturning(status: number, ...pages: object[]) {
  const urls: string[] = [];
  const fake = (url: string) => {
    urls.push(url);
    const body = pages.shift() ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch: fake as unknown as typeof fetch, urls };
}

describe("jobTarget", () => {
  const targets = new Set([T]);

  it("reads the table a DDL or DML job names", () => {
    expect(jobTarget(ctas, targets)).toBe(T);
  });

  it("matches a SCRIPT's write target in its SQL", () => {
    expect(jobTarget(script, targets)).toBe(T);
    const merge = {
      configuration: {
        query: { query: "MERGE `proj.analytics.orders_daily` T USING (SELECT 1) S ON FALSE" },
      },
    };
    expect(jobTarget(merge, targets)).toBe(T);
  });

  it("ignores reads, anonymous result tables and other tables", () => {
    const read = {
      configuration: { query: { query: "SELECT * FROM `proj.analytics.orders_daily`" } },
    };
    expect(jobTarget(read, targets)).toBeUndefined();
    const anon = {
      configuration: {
        query: { destinationTable: { projectId: "proj", datasetId: "_abc", tableId: "anon1" } },
      },
    };
    expect(jobTarget(anon, targets)).toBeUndefined();
    const other = {
      statistics: {
        query: { ddlTargetTable: { projectId: "proj", datasetId: "analytics", tableId: "x" } },
      },
    };
    expect(jobTarget(other, targets)).toBeUndefined();
  });
});

describe("jobRebuilt", () => {
  const withSql = (query: string) => ({
    configuration: { query: { query } },
    statistics: { query: { statementType: "SCRIPT" } },
  });

  it("reads the statement type of a job that names its table", () => {
    expect(jobRebuilt(ctas, T)).toBe(true);
    const insert = { statistics: { query: { statementType: "INSERT" } } };
    expect(jobRebuilt(insert, T)).toBe(false);
    const merge = { statistics: { query: { statementType: "MERGE" } } };
    expect(jobRebuilt(merge, T)).toBe(false);
  });

  it("tells a SCRIPT's full refresh from its incremental run", () => {
    expect(jobRebuilt(script, T)).toBe(false);
    const full = withSql(
      "DECLARE checkpoint DATE; CREATE OR REPLACE TABLE `proj.analytics.orders_daily` AS SELECT 1 AS a",
    );
    expect(jobRebuilt(full, T)).toBe(true);
  });

  it("says nothing when a script both rebuilds and adds, or writes neither", () => {
    const both = withSql(
      "CREATE TABLE `proj.analytics.orders_daily` AS SELECT 1 AS a; INSERT INTO `proj.analytics.orders_daily` SELECT 2",
    );
    expect(jobRebuilt(both, T)).toBeUndefined();
    expect(jobRebuilt(withSql("SELECT 1"), T)).toBeUndefined();
  });
});

describe("readRefreshHistory", () => {
  const options = (f: typeof fetch) => ({
    projectId: "proj",
    getAccessToken: () => Promise.resolve("t"),
    fetch: f,
  });

  it("keeps the newest successful run per table, from all users' jobs", async () => {
    const failed = { ...ctas, status: { errorResult: { reason: "x" } } };
    const { fetch, urls } = fetchReturning(200, { jobs: [failed, ctas, script] });
    const history = await readRefreshHistory([T], options(fetch));
    expect(history).toEqual({
      status: "ok",
      days: 7,
      project: "proj",
      jobsRead: 3,
      complete: true,
      runs: {
        [T]: {
          endedAt: new Date(1763660002500).toISOString(),
          durationMs: 2500,
          slotMs: 7200000,
          bytesProcessed: 1067347121,
          rebuilt: true,
        },
      },
    });
    expect(urls[0]).toContain("allUsers=true");
  });

  it("leaves bytes out when the job record has none", async () => {
    const { totalBytesProcessed: _, ...statistics } = ctas.statistics;
    const { fetch } = fetchReturning(200, { jobs: [{ ...ctas, statistics }] });
    const history = await readRefreshHistory([T], options(fetch));
    expect(history.status === "ok" && history.runs[T]).not.toHaveProperty("bytesProcessed");
  });

  it("follows pages until every table is found", async () => {
    const { fetch, urls } = fetchReturning(
      200,
      { jobs: [], nextPageToken: "p2" },
      { jobs: [script] },
    );
    const history = await readRefreshHistory([T], options(fetch));
    expect(history).toMatchObject({
      status: "ok",
      runs: { [T]: { durationMs: 90000, bytesProcessed: 241456014, rebuilt: false } },
    });
    expect(urls[1]).toContain("pageToken=p2");
  });

  it("says when the page cap cut the search short", async () => {
    const { fetch } = fetchReturning(200, { jobs: [ctas], nextPageToken: "more" });
    const history = await readRefreshHistory(["proj.analytics.other"], {
      ...options(fetch),
      maxPages: 1,
    });
    expect(history).toMatchObject({ status: "ok", jobsRead: 1, complete: false, runs: {} });
  });

  it("says plainly when the permission is missing", async () => {
    const { fetch } = fetchReturning(403, { error: { message: "denied" } });
    expect(await readRefreshHistory([T], options(fetch))).toEqual({
      status: "unavailable",
      reason:
        "the service account cannot list job history (needs bigquery.jobs.listAll, e.g. BigQuery Resource Viewer)",
    });
  });
});
