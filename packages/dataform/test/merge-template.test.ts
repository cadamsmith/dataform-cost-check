import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeSql } from "@dataform-cost-check/core";

/**
 * Drift guard for `core.mergeSql`, our copy of the MERGE Dataform runs for unique-key
 * incrementals. It takes Dataform's own BigQuery `mergeInto` out of an installed bundle,
 * runs it, and checks our statement is identical. The nightly canary runs it against the
 * oldest and the newest 3.x CLI, and CI against 3.1.6 and core 2.9.0. 3.1.x must match
 * exactly; older versions only up to alias names and whitespace (see `mergeSql`).
 */

/** The 3.x CLI builds the MERGE itself: its bundle sits next to the `dataform` binary. */
function cliBundle(): string | undefined {
  try {
    const bin = execFileSync("which", ["dataform"], { encoding: "utf8" }).trim();
    const bundle = join(dirname(realpathSync(bin)), "bundle.js");
    return existsSync(bundle) ? bundle : undefined;
  } catch {
    return undefined;
  }
}

/** Dataform 2.x builds it in `@dataform/core`, which the 2.x fixture installs. */
const v2CoreBundle = fileURLToPath(
  new URL("../../../fixtures/v2-project/node_modules/@dataform/core/bundle.js", import.meta.url),
);

type Target = { database: string; schema: string; name: string };
interface MergeOptions {
  updatePartitionFilter?: string;
  incrementalPredicates?: string[];
}
/** Calls a bundle's `mergeInto`, whichever generation it is. */
type MergeInto = (
  target: Target,
  columns: string[],
  query: string,
  uniqueKey: string[],
  options: MergeOptions,
) => string;

/**
 * A method's parameters and body, cut out of a bundle by brace counting (which holds
 * because the templates' braces are all `${...}` pairs). `params` picks the overload by
 * arity: the 2.x bundle also has a four-parameter Snowflake `mergeInto`.
 */
function extractMethod(
  source: string,
  name: string,
  params: number,
): { params: string[]; body: string } | undefined {
  const list = Array.from({ length: params }, () => "(\\w+)").join(",\\s*");
  const header = new RegExp(`${name}\\(${list}\\)\\s*\\{`).exec(source);
  if (header === null) return undefined;
  let depth = 1;
  let i = header.index + header[0].length;
  for (; depth > 0 && i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return { params: header.slice(1), body: source.slice(header.index + header[0].length, i - 1) };
}

function compile(method: { params: string[]; body: string }): (...args: unknown[]) => string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- Dataform's own code, already installed and trusted to compile the project
  return new Function(...method.params, method.body) as (...args: unknown[]) => string;
}

/**
 * The BigQuery adapter's `mergeInto` from a bundle. 3.1.x takes the table's `bigquery`
 * options as its fifth argument and calls `buildIncrementalPredicatesString`; older
 * versions take the update filter itself.
 */
export function extractMergeInto(source: string): { mergeInto: MergeInto; current: boolean } {
  const merge = extractMethod(source, "mergeInto", 5);
  if (merge === undefined) throw new Error("No five-parameter mergeInto in the bundle");
  const predicates = extractMethod(source, "buildIncrementalPredicatesString", 1);
  const current =
    predicates !== undefined && merge.body.includes("buildIncrementalPredicatesString");
  const adapter = {
    resolveTarget: (t: Target) => `\`${t.database}.${t.schema}.${t.name}\``,
    ...(predicates !== undefined && { buildIncrementalPredicatesString: compile(predicates) }),
  };
  const fn = compile(merge);
  return {
    current,
    mergeInto: (target, columns, query, uniqueKey, options) =>
      fn.call(
        adapter,
        target,
        columns,
        query,
        uniqueKey,
        current ? options : options.updatePartitionFilter,
      ),
  };
}

/** Aliases and whitespace, which older versions differ in, do not change a dry run's bytes. */
const loosely = (sql: string) =>
  sql
    .replaceAll("DATAFORM_DEST", "T")
    .replaceAll("DATAFORM_SOURCE", "S")
    .replace(/\s+/g, " ")
    .trim();

function expectSameAsDataform(bundle: string) {
  const { mergeInto, current } = extractMergeInto(bundle);
  const target = { database: "proj", schema: "analytics", name: "orders" };
  const query = "SELECT id, v, day FROM `proj.raw.orders` WHERE day > '2026-01-01'";
  const cases: MergeOptions[] = [
    {},
    { updatePartitionFilter: "day >= date_sub(current_date(), interval 3 day)" },
    ...(current
      ? [
          { incrementalPredicates: ["DATAFORM_DEST.v > 0", " "] },
          {
            updatePartitionFilter: "day > '2026-01-01'",
            incrementalPredicates: ["DATAFORM_DEST.v > 0", "DATAFORM_DEST.id != 'x'"],
          },
        ]
      : []),
  ];
  for (const options of cases) {
    const ours = mergeSql(
      "proj.analytics.orders",
      ["id", "v", "day"],
      query,
      ["id", "day"],
      options,
    );
    const theirs = mergeInto(target, ["id", "v", "day"], query, ["id", "day"], options);
    if (current) expect(ours).toBe(theirs);
    else expect(loosely(ours)).toBe(loosely(theirs));
  }
}

describe("mergeSql matches Dataform's MERGE", () => {
  const cli = cliBundle();
  it.skipIf(cli === undefined)("for the installed 3.x CLI", () => {
    expectSameAsDataform(readFileSync(cli ?? "", "utf8"));
  });

  it.skipIf(!existsSync(v2CoreBundle))("for Dataform core 2.x", () => {
    expectSameAsDataform(readFileSync(v2CoreBundle, "utf8"));
  });

  it("finds the BigQuery mergeInto, not another adapter's", () => {
    const source = `class S { mergeInto(a,b,c,d){return "snowflake"} }
      class B { mergeInto(e,t,r,n,i){return \`merge \${this.resolveTarget(e)} \${i?"and T."+i:""}\`} }`;
    const { mergeInto, current } = extractMergeInto(source);
    expect(current).toBe(false);
    expect(
      mergeInto({ database: "p", schema: "d", name: "t" }, [], "", [], {
        updatePartitionFilter: "x",
      }),
    ).toBe("merge `p.d.t` and T.x");
  });
});
