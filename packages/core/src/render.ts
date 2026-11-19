import type { Estimate, LikelyCause, Report } from "./types.ts";

type Estimated = Extract<Estimate, { status: "estimated" }>;
type NotEstimated = Exclude<Estimate, { status: "estimated" }>;

/** Hidden marker the action uses to find and update its own sticky comment. */
export const COMMENT_MARKER = "<!-- dataform-cost-check -->";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** One kind of cause so far: a lost partition filter. */
function causeText(cause: LikelyCause): string {
  return `a filter on the partitioned table \`${cause.table}\` was removed`;
}

/** Render the sticky PR comment. Wording always says "estimate", never "cost". */
export function renderComment(report: Report): string {
  const estimated = report.estimates.filter((e): e is Estimated => e.status === "estimated");
  const notEstimated = report.estimates.filter((e): e is NotEstimated => e.status !== "estimated");
  const lines: string[] = [COMMENT_MARKER, "### Dataform Cost Check: BigQuery estimate", ""];

  if (report.estimates.length === 0) {
    lines.push("No models changed in this pull request, so there is nothing to estimate.", "");
    lines.push(footer(report));
    return lines.join("\n") + "\n";
  }

  lines.push(headline(report), "");

  if (estimated.length > 0) {
    lines.push(
      "| Model | Change | Scanned per run (before → after) | Runs / day | Monthly estimate |",
      "|---|---|---|--:|--:|",
    );
    for (const e of estimated) {
      lines.push(
        `| \`${e.name}\` | ${e.kind} | ${formatBytes(e.baseBytes)} → ${formatBytes(e.headBytes)} | ${String(e.runsPerDay)} | ${formatUsd(e.monthlyDelta, { signed: true })} |`,
      );
    }
    lines.push("");

    const causes = estimated.flatMap((e) =>
      e.likelyCause === undefined
        ? []
        : [`- \`${e.name}\`: likely cause: ${causeText(e.likelyCause)}.`],
    );
    if (causes.length > 0) lines.push(...causes, "");
  }

  if (notEstimated.length > 0) {
    lines.push("**Not estimated**", "");
    for (const e of notEstimated) lines.push(`- \`${e.name}\` (${e.kind}): ${e.reason}`);
    lines.push("");
  }

  lines.push(footer(report));
  return lines.join("\n") + "\n";
}

function headline(report: Report): string {
  const total = report.totalMonthlyDelta;
  const hasEstimates = report.estimates.some((e) => e.status === "estimated");
  let text: string;
  if (!hasEstimates) text = "None of the changed models were estimated.";
  else if (total > 0)
    text = `This change adds an estimated **${formatUsd(total, { signed: true })} / month**.`;
  else if (total < 0) text = `This change saves an estimated **${formatUsd(-total)} / month**.`;
  else text = "This change does not move the monthly estimate.";

  if (report.limitMonthly !== null) {
    const limit = formatUsd(report.limitMonthly);
    text += report.overLimit ? ` :x: Over the ${limit} limit.` : ` Within the ${limit} limit.`;
  }
  return text;
}

function footer(report: Report): string {
  return [
    `<sub>Estimates are upper bounds from BigQuery dry runs, priced at ${formatUsd(report.pricePerTib)} per TiB on-demand, `,
    "with no free-tier deduction. If this project uses slot-based (Editions) pricing, bytes scanned ",
    "do not map to dollars and these figures do not apply.</sub>",
  ].join("");
}

/** Human-readable binary size, e.g. `1.24 TiB`. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? "B"}`;
}

/** USD with two decimals and thousands separators. `signed` adds `+` to positive values. */
export function formatUsd(amount: number, { signed = false }: { signed?: boolean } = {}): string {
  const abs = Math.abs(amount);
  if (abs > 0 && abs < 0.005) return amount < 0 ? "-<$0.01" : `${signed ? "+" : ""}<$0.01`;
  const body = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = amount < 0 ? "-" : signed && amount > 0 ? "+" : "";
  return `${sign}$${body}`;
}
