import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  COMMENT_MARKER,
  COMMENT_MAX_LENGTH,
  commentMarker,
  formatBytes,
  formatUsd,
  renderComment,
} from "../src/index.ts";
import type { Estimate, Report } from "../src/index.ts";

const TIB = BYTES_PER_TIB;

const ordersDaily: Estimate = {
  status: "estimated",
  target: "proj.analytics.orders_daily",
  name: "orders_daily",
  kind: "modified",
  type: "incremental",
  baseBytes: 0.04 * TIB,
  headBytes: 1.24 * TIB,
  runsPerDay: 30,
  pricePerTib: 6.25,
  monthlyDelta: 6750,
  likelyCause: { kind: "partition-filter-removed", table: "proj.raw.orders" },
  fullRefreshBytes: 3.1 * TIB,
};

const customers: Estimate = {
  status: "estimated",
  target: "proj.analytics.customers",
  name: "customers",
  kind: "added",
  type: "table",
  baseBytes: 0,
  headBytes: 5 * 1024 ** 3,
  runsPerDay: 1,
  pricePerTib: 6.25,
  monthlyDelta: 0.92,
};

const view: Estimate = {
  status: "skipped",
  target: "proj.analytics.orders_v",
  name: "orders_v",
  kind: "modified",
  type: "view",
  reason: "Views cost nothing to create; the cost lands on whatever reads them.",
};

const broken: Estimate = {
  status: "unestimable",
  target: "proj.analytics.new_rollup",
  name: "new_rollup",
  kind: "added",
  type: "table",
  reason:
    "Dry run at head failed: BigQuery rejected the query. BigQuery's message is in the job log.",
  errorKind: "query-error",
  detail: "Syntax error: Unclosed string literal 'secret-customer-id' at [3:14]",
};

function report(overrides: Partial<Report>): Report {
  return {
    estimates: [],
    totalMonthlyDelta: 0,
    pricePerTib: 6.25,
    limitMonthly: null,
    overLimit: false,
    ...overrides,
  };
}

describe("renderComment", () => {
  it("never renders BigQuery's message, which can quote the query", () => {
    const comment = renderComment(report({ estimates: [broken] }));
    expect(comment).not.toContain("secret-customer-id");
    expect(comment).toContain("BigQuery rejected the query");
  });

  it("renders an increase over the limit with every kind of row", () => {
    expect(
      renderComment(
        report({
          estimates: [ordersDaily, customers, view, broken],
          totalMonthlyDelta: 6750.92,
          fullRefresh: { baseUsd: 12.5, headUsd: 19.69, leftOut: 1 },
          limitMonthly: 100,
          overLimit: true,
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders a saving within the limit", () => {
    const saving: Estimate = {
      ...customers,
      kind: "removed",
      baseBytes: 5 * 1024 ** 3,
      headBytes: 0,
      monthlyDelta: -0.92,
    };
    expect(
      renderComment(report({ estimates: [saving], totalMonthlyDelta: -0.92, limitMonthly: 100 })),
    ).toMatchSnapshot();
  });

  it("renders a pull request with no model changes", () => {
    expect(renderComment(report({}))).toMatchSnapshot();
  });

  it("does not call an all-failed run within the limit", () => {
    const body = renderComment(report({ estimates: [broken], limitMonthly: 100 }));
    expect(body).toContain("None of the changed models were estimated.");
    expect(body).not.toContain("Within the");
  });

  it("renders when nothing could be estimated", () => {
    expect(renderComment(report({ estimates: [view, broken] }))).toMatchSnapshot();
  });

  it("starts with the sticky marker and never calls the figure a cost", () => {
    const body = renderComment(report({ estimates: [ordersDaily], totalMonthlyDelta: 6750 }));
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("estimate");
    // The product name contains "cost"; the rule is about how the figures are described.
    const afterTitle = body.split("\n").slice(2).join("\n").replaceAll("dataform-cost-check", "");
    expect(afterTitle).not.toMatch(/\bcosts?\b/i);
    expect(body).toContain("slot-based (Editions) pricing");
  });
});

describe("renderComment size cap", () => {
  const many: Estimate[] = Array.from({ length: 2000 }, (_, i) => ({
    ...customers,
    target: `proj.analytics.model_${String(i)}`,
    name: `model_with_a_fairly_long_name_${String(i)}`,
    monthlyDelta: i,
  }));
  const failures: Estimate[] = Array.from({ length: 500 }, (_, i) => ({
    ...broken,
    name: `broken_${String(i)}`,
  }));
  const big = report({
    estimates: [...failures, ...many],
    totalMonthlyDelta: 1_999_000,
    limitMonthly: 100,
    overLimit: true,
  });

  it("stays under the length cap and keeps the verdict, largest changes first", () => {
    const body = renderComment(big);
    expect(body.length).toBeLessThanOrEqual(COMMENT_MAX_LENGTH);
    expect(body).toContain(":x: Over the $100.00 limit.");
    expect(body).toContain("slot-based (Editions) pricing");
    expect(body).toMatch(
      /…and \d+ more models, left out to keep this comment short\. The job summary has the full report\./,
    );
    expect(body.indexOf("model_with_a_fairly_long_name_1999`")).toBeLessThan(
      body.indexOf("model_with_a_fairly_long_name_1998`"),
    );
    expect(body).not.toContain("model_with_a_fairly_long_name_0`");
  });

  it("counts every model left out", () => {
    const body = renderComment(big, { maxLength: 5000 });
    const rows = body.split("\n").filter((l) => l.startsWith("| `") || l.startsWith("- `")).length;
    const omitted = Number(/…and (\d+) more models/.exec(body)?.[1]);
    expect(rows + omitted).toBe(2500);
    expect(body.length).toBeLessThanOrEqual(5000);
  });

  it("renders everything when it fits", () => {
    const body = renderComment(big, { maxLength: Number.POSITIVE_INFINITY });
    expect(body).not.toContain("more models");
    expect(body).toContain("broken_499");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1536, "1.50 KiB"],
    [5 * 1024 ** 3, "5.00 GiB"],
    [1.24 * TIB, "1.24 TiB"],
    [3 * 1024 * TIB, "3.00 PiB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatUsd", () => {
  it.each([
    [0, false, "$0.00"],
    [225, true, "+$225.00"],
    [1234.5, false, "$1,234.50"],
    [-3.1, true, "-$3.10"],
    [0.001, true, "+<$0.01"],
    [-0.001, false, "-<$0.01"],
  ])("formats %d (signed: %s) as %s", (amount, signed, expected) => {
    expect(formatUsd(amount, { signed })).toBe(expected);
  });
});

describe("renderComment at 0 per TiB", () => {
  const unpriced: Estimate = { ...customers, name: "slots_model", pricePerTib: 0, monthlyDelta: 0 };

  it("shows bytes, not dollars, and says the limit cannot apply", () => {
    const body = renderComment(
      report({ estimates: [unpriced], pricePerTib: 0, limitMonthly: 100 }),
    );
    expect(body).toMatchSnapshot();
    expect(body).not.toContain("$0.00");
    expect(body).not.toContain("does not move the monthly estimate");
    expect(body).toContain("The $100.00 limit cannot apply.");
    expect(body).toContain("| bytes only |");
  });

  it("leaves models at 0 per TiB out of a mixed dollar figure, and says so", () => {
    const body = renderComment(
      report({
        estimates: [customers, unpriced],
        totalMonthlyDelta: 0.92,
        pricePerTibByLocation: { EU: 0 },
      }),
    );
    expect(body).toContain("adds an estimated **+$0.92 / month**.");
    expect(body).toContain("1 model is priced at 0 per TiB and left out of the dollar figure");
    expect(body).toContain("(0 (bytes only) in EU)");
  });
});

describe("refresh history", () => {
  it("shows last runs as labelled history with slot-hours", () => {
    const body = renderComment(
      report({
        estimates: [ordersDaily, customers],
        totalMonthlyDelta: 6750.92,
        history: {
          status: "ok",
          days: 7,
          project: "proj",
          jobsRead: 120,
          complete: true,
          runs: {
            [ordersDaily.target]: {
              endedAt: "2026-11-20T19:58:12.000Z",
              durationMs: 95_000,
              slotMs: 7_200_000,
            },
          },
        },
      }),
    );
    expect(body).toContain("**Last refresh** (history from BigQuery job records, not a forecast)");
    expect(body).toContain("| `orders_daily` | 2026-11-20 19:58 UTC | 1.6 min | 2.000 |");
    expect(body).not.toContain("| `customers` | 2026");
  });

  it("says why history is missing, and when no run was found", () => {
    const off = renderComment(
      report({
        estimates: [customers],
        history: { status: "unavailable", reason: "no permission" },
      }),
    );
    expect(off).toContain("Refresh history is turned on, but no permission.");
    const none = renderComment(
      report({
        estimates: [customers],
        history: {
          status: "ok",
          days: 7,
          project: "proj",
          jobsRead: 120,
          complete: true,
          runs: {},
        },
      }),
    );
    expect(none).toContain(
      "No run of the changed models found in the last 7 days of `proj`'s job records.",
    );
    const capped = renderComment(
      report({
        estimates: [customers],
        history: {
          status: "ok",
          days: 7,
          project: "proj",
          jobsRead: 5000,
          complete: false,
          runs: {},
        },
      }),
    );
    expect(capped).toContain(
      "No run of the changed models found in the most recent 5,000 job records of `proj` (a busy project: older runs were not searched).",
    );
  });

  it("adds nothing when history is off", () => {
    expect(renderComment(report({ estimates: [customers] }))).not.toContain("Last refresh");
  });
});

describe("unique-key incremental models", () => {
  type Merge = NonNullable<Extract<Estimate, { status: "estimated" }>["merge"]>;
  const merged: Estimate = {
    ...customers,
    name: "orders_merge",
    merge: { partitionFiltered: false, readsOwnTable: false, sizing: { by: "query" } },
  };
  const note = (merge: Merge) =>
    renderComment(report({ estimates: [{ ...merged, merge }], totalMonthlyDelta: 0.92 }))
      .split("\n")
      .find((line) => line.startsWith("- `orders_merge`: has a unique key"));
  const start = "- `orders_merge`: has a unique key, so each run is a MERGE";
  const reads = `${start} that also reads part or all of the existing table.`;
  const lowerBound = "Those bytes are not included, so this model's figure is a lower bound.";
  const query = { by: "query" } as const;

  it("says the figure is exact when the MERGE itself was dry-run", () => {
    expect(note({ partitionFiltered: true, readsOwnTable: true, sizing: { by: "merge" } })).toBe(
      `${start}. Sized by a dry run of that MERGE, including its read of the existing table.`,
    );
  });

  it("gives the range when the MERGE dry run was denied or failed", () => {
    const range = {
      by: "range",
      fromBytes: 2 ** 30,
      toBytes: 5 * 2 ** 30,
      errorKind: "permission-denied",
      detail: "secret SQL in the message",
    } as const;
    const denied = note({ partitionFiltered: false, readsOwnTable: false, sizing: range });
    expect(denied).toBe(
      `${reads} A dry run of the MERGE needs write access to the table, which the check's account does not have, so this model's figure covers its query alone: each run reads between 1.00 GiB and 5.00 GiB (with the whole table).`,
    );
    const failed = note({
      partitionFiltered: false,
      readsOwnTable: false,
      sizing: { ...range, errorKind: "query-error" },
    });
    expect(failed).toContain(
      "The dry run of the MERGE failed (BigQuery's message is in the job log)",
    );
    expect(failed).not.toContain("secret");
  });

  it("speaks of the base when this change drops the unique key", () => {
    const line = renderComment(
      report({
        estimates: [
          {
            ...merged,
            merge: {
              partitionFiltered: false,
              readsOwnTable: false,
              sizing: query,
              baseOnly: true,
            },
          },
        ],
        totalMonthlyDelta: 0.92,
      }),
    )
      .split("\n")
      .find((l) => l.startsWith("- `orders_merge`:"));
    expect(line).toBe(
      "- `orders_merge`: had a unique key before this change, so each run at base is a MERGE that also reads part or all of the existing table. Those bytes are not included, so the base figure is a lower bound. An `updatePartitionFilter` can limit that read.",
    );
  });

  it("says the read of the existing table is not included when the table was not looked up", () => {
    expect(note({ partitionFiltered: false, readsOwnTable: false, sizing: query })).toBe(
      `${reads} ${lowerBound} An \`updatePartitionFilter\` can limit that read.`,
    );
    expect(note({ partitionFiltered: true, readsOwnTable: false, sizing: query })).toBe(
      `${reads} ${lowerBound}`,
    );
    expect(note({ partitionFiltered: false, readsOwnTable: true, sizing: query })).toBe(
      `${reads} ${lowerBound}`,
    );
    expect(note({ partitionFiltered: true, readsOwnTable: true, sizing: query })).toBe(
      `${reads} ${lowerBound} Its \`updatePartitionFilter\` does not limit that read, because the query also reads this table.`,
    );
  });
});

describe("commentMarker and monorepos", () => {
  it("keeps the plain marker for the root project", () => {
    expect(commentMarker()).toBe(COMMENT_MARKER);
    expect(commentMarker(".")).toBe(COMMENT_MARKER);
    expect(commentMarker("./")).toBe(COMMENT_MARKER);
  });

  it("never puts -- inside the marker, whatever the directory name", () => {
    expect(commentMarker("a--b")).toBe("<!-- dataform-cost-check:a-b -->");
    expect(commentMarker("a---b")).toBe("<!-- dataform-cost-check:a-b -->");
  });

  it("strips a long run of trailing slashes quickly", () => {
    const start = performance.now();
    expect(commentMarker(`analytics${"/".repeat(100_000)}x/`)).toContain("analytics/");
    expect(commentMarker(`analytics${"/".repeat(100_000)}`)).toBe(
      "<!-- dataform-cost-check:analytics -->",
    );
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("gives each project directory its own marker and title", () => {
    expect(commentMarker("./analytics/")).toBe("<!-- dataform-cost-check:analytics -->");
    expect(commentMarker("a/b")).not.toBe(commentMarker("a"));
    const body = renderComment(report({}), { projectDir: "analytics" });
    expect(body.startsWith("<!-- dataform-cost-check:analytics -->")).toBe(true);
    expect(body).toContain("### Dataform Cost Check: BigQuery estimate for `analytics`");
    // A root project's comment must not be mistaken for a subproject's, or the reverse.
    expect(body.startsWith(COMMENT_MARKER)).toBe(false);
  });

  it("says where runs per day come from", () => {
    expect(renderComment(report({}))).toContain(
      "Runs per day come from `dataform-cost-check.yml`, not from your schedules.",
    );
    expect(renderComment(report({}), { configPath: "ci/cost.yml" })).toContain(
      "Runs per day come from `ci/cost.yml`, not from your schedules.",
    );
  });

  it("says when no config file was found and the defaults were used", () => {
    const body = renderComment(report({}), { configFound: false });
    expect(body).toContain(
      "No `dataform-cost-check.yml` found, so every model is assumed to run once a day and no limit applies.",
    );
    expect(body).not.toContain("Runs per day come from");
  });
});

describe("renderComment pricing footer", () => {
  it("lists per-location prices when configured", () => {
    const body = renderComment(report({ pricePerTibByLocation: { "asia-northeast1": 7.5 } }));
    expect(body).toContain("priced at $6.25 per TiB on-demand ($7.50 in asia-northeast1),");
  });
});

describe("renderComment with built-in list prices", () => {
  it("names Google's list price and its date in the footer", () => {
    const body = renderComment(
      report({ listPrices: { asOf: "2026-11-20", byLocation: { "europe-west2": 7.8125 } } }),
    );
    expect(body).toContain(
      "priced at Google's on-demand list price for each location as of 2026-11-20 ($7.81 per TiB in europe-west2; otherwise $6.25 per TiB on-demand),",
    );
  });
});

describe("readers of changed views", () => {
  it("says why a model with unchanged SQL is listed", () => {
    const body = renderComment(
      report({
        estimates: [{ ...customers, name: "daily", kind: "modified", viaViews: ["orders_v"] }],
      }),
    );
    expect(body).toContain(
      "- `daily`: its own SQL is unchanged, but it reads `orders_v`, which this pull request changes. Estimated with the new view definition.",
    );
  });
});

describe("runs per day that change", () => {
  it("shows base and head runs per day in the row", () => {
    const body = renderComment(
      report({
        estimates: [{ ...customers, kind: "modified", baseRunsPerDay: 1, runsPerDay: 24 }],
      }),
    );
    expect(body).toContain("| `customers` | modified | 0 B → 5.00 GiB | 1 → 24 / day | +$0.92 |");
  });

  it("names the unit on both sides when a change crosses into weekly", () => {
    const body = renderComment(
      report({
        estimates: [{ ...customers, kind: "modified", baseRunsPerDay: 1, runsPerDay: 1 / 7 }],
      }),
    );
    expect(body).toContain("| 1 / day → 1 / week |");
  });
});

describe("full refresh line", () => {
  it("shows one rebuild before and after, outside the monthly figure", () => {
    const body = renderComment(
      report({
        estimates: [ordersDaily],
        fullRefresh: { baseUsd: 12.5, headUsd: 43.75, leftOut: 0 },
      }),
    );
    expect(body).toContain(
      "**Full refresh:** one rebuild of the changed models from scratch, an estimated $12.50 → $43.75 (+$31.25), not part of the monthly figure.",
    );
  });

  it("says how many changed models it left out", () => {
    const one = renderComment(
      report({ estimates: [ordersDaily], fullRefresh: { baseUsd: 1, headUsd: 2, leftOut: 1 } }),
    );
    expect(one).toContain("1 changed model is left out: its rebuild could not be sized.");
    const two = renderComment(
      report({ estimates: [ordersDaily], fullRefresh: { baseUsd: 1, headUsd: 2, leftOut: 2 } }),
    );
    expect(two).toContain("2 changed models are left out: their rebuild could not be sized.");
  });

  it("is absent without a figure", () => {
    expect(renderComment(report({ estimates: [ordersDaily] }))).not.toContain("Full refresh:");
  });
});

describe("full refresh line, nothing sized", () => {
  it("says so instead of showing $0.00", () => {
    const body = renderComment(
      report({ estimates: [ordersDaily], fullRefresh: { baseUsd: 0, headUsd: 0, leftOut: 1 } }),
    );
    expect(body).toContain("**Full refresh:** could not be sized for 1 changed model.");
  });
});
