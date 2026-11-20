import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  COMMENT_MARKER,
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

  it("renders when nothing could be estimated", () => {
    expect(renderComment(report({ estimates: [view, broken] }))).toMatchSnapshot();
  });

  it("starts with the sticky marker and never calls the figure a cost", () => {
    const body = renderComment(report({ estimates: [ordersDaily], totalMonthlyDelta: 6750 }));
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("estimate");
    // The product name contains "cost"; the rule is about how the figures are described.
    const afterTitle = body.split("\n").slice(2).join("\n");
    expect(afterTitle).not.toMatch(/\bcosts?\b/i);
    expect(body).toContain("slot-based (Editions) pricing");
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

describe("renderComment pricing footer", () => {
  it("lists per-location prices when configured", () => {
    const body = renderComment(report({ pricePerTibByLocation: { "asia-northeast1": 7.5 } }));
    expect(body).toContain("priced at $6.25 per TiB on-demand ($7.50 in asia-northeast1),");
  });
});
