import { describe, expect, it } from "vitest";
import { jobTarget, readRefreshHistory } from "../src/index.ts";

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
      runs: {
        [T]: { endedAt: new Date(1763660002500).toISOString(), durationMs: 2500, slotMs: 7200000 },
      },
    });
    expect(urls[0]).toContain("allUsers=true");
  });

  it("follows pages until every table is found", async () => {
    const { fetch, urls } = fetchReturning(
      200,
      { jobs: [], nextPageToken: "p2" },
      { jobs: [script] },
    );
    const history = await readRefreshHistory([T], options(fetch));
    expect(history).toMatchObject({ status: "ok", runs: { [T]: { durationMs: 90000 } } });
    expect(urls[1]).toContain("pageToken=p2");
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
