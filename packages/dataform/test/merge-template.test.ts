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
 * oldest and the newest 3.x CLI, and CI against 3.1.6 and core 2.9.0.
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

type MergeInto = (
  target: { database: string; schema: string; name: string },
  columns: string[],
  query: string,
  uniqueKey: string[],
  updatePartitionFilter?: string,
) => string;

/**
 * The BigQuery adapter's `mergeInto` from a bundle: the one with five parameters (the
 * 2.x Snowflake adapter has a four-parameter one). Its body is cut out by brace counting,
 * which holds because the template's braces are all `${...}` pairs.
 */
export function extractMergeInto(source: string): MergeInto {
  const header = /mergeInto\((\w+),\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+)\)\s*\{/.exec(source);
  if (header === null) throw new Error("No five-parameter mergeInto in the bundle");
  let depth = 1;
  let i = header.index + header[0].length;
  for (; depth > 0 && i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  const body = source.slice(header.index + header[0].length, i - 1);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- Dataform's own code, already installed and trusted to compile the project
  const fn = new Function(...header.slice(1), body) as (...args: unknown[]) => string;
  const adapter = {
    resolveTarget: (t: { database: string; schema: string; name: string }) =>
      `\`${t.database}.${t.schema}.${t.name}\``,
  };
  return (...args) => fn.apply(adapter, args);
}

function expectSameAsDataform(mergeInto: MergeInto) {
  const target = { database: "proj", schema: "analytics", name: "orders" };
  const query = "SELECT id, v, day FROM `proj.raw.orders` WHERE day > '2026-01-01'";
  for (const filter of [undefined, "day >= date_sub(current_date(), interval 3 day)"]) {
    expect(
      mergeSql("proj.analytics.orders", ["id", "v", "day"], query, ["id", "day"], filter),
    ).toBe(mergeInto(target, ["id", "v", "day"], query, ["id", "day"], filter));
  }
}

describe("mergeSql matches Dataform's MERGE", () => {
  const cli = cliBundle();
  it.skipIf(cli === undefined)("for the installed 3.x CLI", () => {
    expectSameAsDataform(extractMergeInto(readFileSync(cli ?? "", "utf8")));
  });

  it.skipIf(!existsSync(v2CoreBundle))("for Dataform core 2.x", () => {
    expectSameAsDataform(extractMergeInto(readFileSync(v2CoreBundle, "utf8")));
  });

  it("finds the BigQuery mergeInto, not another adapter's", () => {
    const source = `class S { mergeInto(a,b,c,d){return "snowflake"} }
      class B { mergeInto(e,t,r,n,i){return \`merge \${this.resolveTarget(e)} \${i?"and T."+i:""}\`} }`;
    expect(
      extractMergeInto(source)({ database: "p", schema: "d", name: "t" }, [], "", [], "x"),
    ).toBe("merge `p.d.t` and T.x");
  });
});
