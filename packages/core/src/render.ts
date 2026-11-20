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
      const monthly =
        e.pricePerTib === 0 ? "bytes only" : formatUsd(e.monthlyDelta, { signed: true });
      lines.push(
        `| \`${e.name}\` | ${e.kind} | ${formatBytes(e.baseBytes)} → ${formatBytes(e.headBytes)} | ${String(e.runsPerDay)} | ${monthly} |`,
      );
    }
    lines.push("");

    const notes = estimated.flatMap((e) => [
      ...(e.likelyCause === undefined
        ? []
        : [`- \`${e.name}\`: likely cause: ${causeText(e.likelyCause)}.`]),
      ...(e.fullRefreshBytes === undefined
        ? []
        : [
            `- \`${e.name}\`: incremental, estimated from its incremental query. A full refresh would scan up to ${formatBytes(e.fullRefreshBytes)}, not included in the monthly estimate.`,
          ]),
    ]);
    if (notes.length > 0) lines.push(...notes, "");
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
  const estimated = report.estimates.filter((e): e is Estimated => e.status === "estimated");
  const unpriced = estimated.filter((e) => e.pricePerTib === 0).length;
  let text: string;
  if (estimated.length === 0) text = "None of the changed models were estimated.";
  else if (unpriced === estimated.length) {
    text =
      "These models are priced at 0 per TiB (for example, slot-based pricing), so bytes scanned are shown, not dollars.";
    if (report.limitMonthly !== null) {
      text += ` The ${formatUsd(report.limitMonthly)} limit cannot apply.`;
    }
    return text;
  } else if (total > 0)
    text = `This change adds an estimated **${formatUsd(total, { signed: true })} / month**.`;
  else if (total < 0) text = `This change saves an estimated **${formatUsd(-total)} / month**.`;
  else text = "This change does not move the monthly estimate.";

  if (report.limitMonthly !== null) {
    const limit = formatUsd(report.limitMonthly);
    text += report.overLimit ? ` :x: Over the ${limit} limit.` : ` Within the ${limit} limit.`;
  }
  if (unpriced > 0) {
    const models = unpriced === 1 ? "1 model is" : `${String(unpriced)} models are`;
    text += ` ${models} priced at 0 per TiB and left out of the dollar figure; bytes are shown for them.`;
  }
  return text;
}

function footer(report: Report): string {
  const byLocation = Object.entries(report.pricePerTibByLocation ?? {}).map(
    ([location, price]) => `${price === 0 ? "0 (bytes only)" : formatUsd(price)} in ${location}`,
  );
  const price =
    byLocation.length === 0
      ? `${perTib(report.pricePerTib)} on-demand`
      : `${perTib(report.pricePerTib)} on-demand (${byLocation.join(", ")})`;
  return [
    `<sub>Estimates are upper bounds from BigQuery dry runs, priced at ${price}, `,
    "with no free-tier deduction. If this project uses slot-based (Editions) pricing, bytes scanned ",
    "do not map to dollars and these figures do not apply.</sub>",
  ].join("");
}

/** A configured price, where 0 means "bytes only, no dollars". */
function perTib(price: number): string {
  return price === 0 ? "0 per TiB (bytes only)" : `${formatUsd(price)} per TiB`;
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
