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

/**
 * Longest comment the action posts. Editing shared includes can change every model, and a
 * wall of rows buries the verdict, so the comment stops adding rows here; the headline
 * and verdict always survive. (GitHub's documented 65,536-character limit was not
 * enforced when tested on 2026-11-20: a 162,087-character comment was accepted.)
 */
export const COMMENT_MAX_LENGTH = 60_000;

/** Room kept for the line that says how many models were left out. */
const OVERFLOW_RESERVE = 200;

export interface RenderOptions {
  /** Stop adding rows before the comment passes this many characters. */
  readonly maxLength?: number;
  /** Where the reader finds the rows left out, said after the count. */
  readonly fullReportAt?: string;
}

/**
 * Render the sticky PR comment. Wording always says "estimate", never "cost". The
 * headline, the verdict and the footer always appear. Rows go in order of how much they
 * move the estimate, largest first; when `maxLength` would be passed, the rest are left
 * out and counted.
 */
export function renderComment(
  report: Report,
  {
    maxLength = COMMENT_MAX_LENGTH,
    fullReportAt = "The job summary has the full report.",
  }: RenderOptions = {},
): string {
  const head = [COMMENT_MARKER, "### Dataform Cost Check: BigQuery estimate", ""];
  const tail = footer(report);

  if (report.estimates.length === 0) {
    return (
      [
        ...head,
        "No models changed in this pull request, so there is nothing to estimate.",
        "",
        tail,
      ].join("\n") + "\n"
    );
  }
  head.push(headline(report), "");

  const estimated = report.estimates
    .filter((e): e is Estimated => e.status === "estimated")
    .sort(byImpact);
  const notEstimated = report.estimates.filter((e): e is NotEstimated => e.status !== "estimated");

  const body: string[] = [];
  let length = [...head, tail].join("\n").length + OVERFLOW_RESERVE;
  const fits = (lines: readonly string[]): boolean => {
    const added = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (length + added > maxLength) return false;
    length += added;
    return true;
  };

  const shown: Estimated[] = [];
  const tableHeader = [
    "| Model | Change | Scanned per run (before → after) | Runs / day | Monthly estimate |",
    "|---|---|---|--:|--:|",
  ];
  if (estimated.length > 0 && fits([...tableHeader, ""])) {
    for (const e of estimated) {
      if (!fits([row(e)])) break;
      shown.push(e);
    }
    body.push(...tableHeader, ...shown.map(row), "");

    const notes: string[] = [];
    for (const e of shown) {
      const lines = notesFor(e);
      if (lines.length === 0) continue;
      if (!fits(lines)) break;
      notes.push(...lines);
    }
    if (notes.length > 0 && fits([""])) body.push(...notes, "");
  }

  let listed = 0;
  if (notEstimated.length > 0 && fits(["**Not estimated**", "", ""])) {
    const items: string[] = [];
    for (const e of notEstimated) {
      const line = `- \`${e.name}\` (${e.kind}): ${e.reason}`;
      if (!fits([line])) break;
      items.push(line);
    }
    listed = items.length;
    if (listed > 0) body.push("**Not estimated**", "", ...items, "");
  }

  const omitted = report.estimates.length - shown.length - listed;
  if (omitted > 0) {
    const models = omitted === 1 ? "1 more model" : `${String(omitted)} more models`;
    body.push(`…and ${models}, left out to keep this comment short. ${fullReportAt}`, "");
  }

  return [...head, ...body, tail].join("\n") + "\n";
}

/** Largest change in the estimate first; byte change breaks ties (e.g. models at 0 per TiB). */
function byImpact(a: Estimated, b: Estimated): number {
  return (
    Math.abs(b.monthlyDelta) - Math.abs(a.monthlyDelta) ||
    Math.abs(b.headBytes - b.baseBytes) - Math.abs(a.headBytes - a.baseBytes)
  );
}

function row(e: Estimated): string {
  const monthly = e.pricePerTib === 0 ? "bytes only" : formatUsd(e.monthlyDelta, { signed: true });
  return `| \`${e.name}\` | ${e.kind} | ${formatBytes(e.baseBytes)} → ${formatBytes(e.headBytes)} | ${String(e.runsPerDay)} | ${monthly} |`;
}

function notesFor(e: Estimated): string[] {
  return [
    ...(e.likelyCause === undefined
      ? []
      : [`- \`${e.name}\`: likely cause: ${causeText(e.likelyCause)}.`]),
    ...(e.fullRefreshBytes === undefined
      ? []
      : [
          `- \`${e.name}\`: incremental, estimated from its incremental query. A full refresh would scan up to ${formatBytes(e.fullRefreshBytes)}, not included in the monthly estimate.`,
        ]),
  ];
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

  // With nothing estimated, "within the limit" would read as a pass while the check fails.
  if (report.limitMonthly !== null && estimated.length > 0) {
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
