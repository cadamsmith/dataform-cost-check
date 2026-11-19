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
  reason: "Dry run at head failed: Not found: Table proj:analytics.new_upstream",
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
