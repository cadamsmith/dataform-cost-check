import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TIB,
  buildReport,
  DEFAULT_CONFIG,
  monthlyDelta,
  renderComment,
} from "../src/index.ts";
import type { Estimate } from "../src/index.ts";

/**
 * The sample comment in README.md comes from the real renderer, so it cannot drift from
 * what the action posts. Regenerate with `pnpm readme`. The figures are illustrative.
 */
const README = fileURLToPath(new URL("../../../README.md", import.meta.url));
const BEGIN = "<!-- BEGIN GENERATED: sample comment (pnpm readme) -->";
const END = "<!-- END GENERATED -->";

const estimates: Estimate[] = [
  {
    status: "estimated",
    target: "proj.analytics.orders_daily",
    name: "orders_daily",
    kind: "modified",
    type: "table",
    baseBytes: 0.04 * BYTES_PER_TIB,
    headBytes: 1.24 * BYTES_PER_TIB,
    runsPerDay: 1,
    pricePerTib: 6.25,
    monthlyDelta: monthlyDelta(0.04 * BYTES_PER_TIB, 1.24 * BYTES_PER_TIB, 6.25, 1),
    likelyCause: { kind: "partition-filter-removed", table: "proj.raw.orders" },
  },
  {
    status: "estimated",
    target: "proj.analytics.customers",
    name: "customers",
    kind: "added",
    type: "table",
    baseBytes: 0,
    headBytes: 5 * 1024 ** 3,
    runsPerDay: 24,
    pricePerTib: 6.25,
    monthlyDelta: monthlyDelta(0, 5 * 1024 ** 3, 6.25, 24),
  },
  {
    status: "skipped",
    target: "proj.analytics.orders_v",
    name: "orders_v",
    kind: "modified",
    type: "view",
    reason: "Views cost nothing to create; the cost lands on whatever reads them.",
  },
];

/** The rendered comment as a Markdown quote, between the markers. */
export function readmeSample(): string {
  const comment = renderComment(buildReport(estimates, { ...DEFAULT_CONFIG, limitMonthly: 100 }));
  const quoted = comment
    .trimEnd()
    .split("\n")
    .slice(1) // the hidden sticky-comment marker
    .map((line) => (line === "" ? ">" : `> ${line}`));
  return [
    BEGIN,
    "<!-- prettier-ignore-start -->",
    ...quoted,
    "<!-- prettier-ignore-end -->",
    END,
  ].join("\n");
}

describe("README sample comment", () => {
  it("matches the real renderer (run `pnpm readme` to update)", () => {
    const readme = readFileSync(README, "utf8");
    const start = readme.indexOf(BEGIN);
    const end = readme.indexOf(END);
    expect(start, "README.md has no generated sample markers").toBeGreaterThanOrEqual(0);
    const current = readme.slice(start, end + END.length);
    const expected = readmeSample();
    if (process.env.UPDATE_README === "1" && current !== expected) {
      writeFileSync(README, readme.replace(current, expected));
      return;
    }
    expect(current).toBe(expected);
  });
});
