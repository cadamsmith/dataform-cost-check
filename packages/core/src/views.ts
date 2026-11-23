import type { Model, ModelChange } from "./types.ts";

/**
 * Keywords that can follow a table reference without being its alias.
 */
const NOT_ALIAS = new Set([
  "where",
  "join",
  "left",
  "right",
  "inner",
  "full",
  "cross",
  "on",
  "group",
  "order",
  "limit",
  "union",
  "window",
  "having",
  "qualify",
  "using",
  "except",
  "intersect",
  "for",
  "tablesample",
  "as",
  "pivot",
  "unpivot",
  "natural",
]);

/**
 * Replace each quoted reference to a view in `definitions` with that view's SQL as a
 * subquery. A dry run reads the view that is live in BigQuery, not the one in the pull
 * request, so a change to a view only shows up in its readers once it is inlined. A
 * reference with no alias gets the view's short name, so `view_name.column` still resolves.
 * Views that the inlined SQL reads are inlined in turn.
 */
export function inlineViews(sql: string, definitions: ReadonlyMap<string, string>): string {
  let out = sql;
  for (const [target, rawViewSql] of definitions) {
    const quoted = `\`${target}\``;
    if (!out.includes(quoted)) continue;
    // A view can read another view in `definitions`: inline those too, whatever the order.
    // Leaving the view itself out stops a loop, though BigQuery rejects circular views.
    const rest = new Map(definitions);
    rest.delete(target);
    const viewSql = inlineViews(rawViewSql, rest);
    let from = 0;
    for (;;) {
      const at = out.indexOf(quoted, from);
      if (at < 0) break;
      const after = out.slice(at + quoted.length);
      const next = /^\s+(?:AS\s+)?([A-Za-z_]\w*)/i.exec(after);
      const hasAlias = next?.[1] !== undefined && !NOT_ALIAS.has(next[1].toLowerCase());
      const asKeyword = /^\s+AS\s+/i.test(after);
      const name = target.split(".").pop() ?? "v";
      const replacement =
        hasAlias || asKeyword ? `(${viewSql.trim()})` : `(${viewSql.trim()}) AS ${name}`;
      out = out.slice(0, at) + replacement + after;
      from = at + replacement.length;
    }
  }
  return out;
}

function withInlined(model: Model, definitions: ReadonlyMap<string, string>): Model {
  if (definitions.size === 0) return model;
  return {
    ...model,
    query: inlineViews(model.query, definitions),
    ...(model.incrementalQuery !== undefined && {
      incrementalQuery: inlineViews(model.incrementalQuery, definitions),
    }),
  };
}

function reads(model: Model, targets: Iterable<string>): string[] {
  const sql = `${model.query}\n${model.incrementalQuery ?? ""}`;
  return [...targets].filter((t) => sql.includes(`\`${t}\``));
}

/**
 * Account for views the pull request changes. Each side's queries get that side's
 * definitions of the changed views inlined (base with base, head with head), including
 * unchanged views that read a changed one, followed transitively. Models whose own SQL did
 * not change but that read an affected view are added as modified, with `viaViews` naming
 * the views. Pure.
 */
export function withViewReaders(
  changes: readonly ModelChange[],
  base: readonly Model[],
  head: readonly Model[],
): ModelChange[] {
  const baseByTarget = new Map(base.map((m) => [m.target, m]));
  // A JIT view has no SQL to inline: readers keep reading the view live in BigQuery.
  const isView = (m: Model | undefined) => m?.type === "view" && m.jitCode === undefined;

  // Views whose definition differs between the sides, as each side defines them.
  const baseDefs = new Map<string, string>();
  const headDefs = new Map<string, string>();
  for (const c of changes) {
    const b = c.kind === "added" ? undefined : c.base;
    const h = c.kind === "removed" ? undefined : c.head;
    if (!isView(b) && !isView(h)) continue;
    if (b !== undefined && isView(b)) baseDefs.set(c.target, b.query);
    if (h !== undefined && isView(h)) headDefs.set(c.target, h.query);
  }
  if (baseDefs.size === 0 && headDefs.size === 0) return [...changes];

  // Unchanged views that read an affected view are affected too: inline until stable.
  const changedTargets = new Set(changes.map((c) => c.target));
  for (let grew = true; grew;) {
    grew = false;
    for (const view of head.filter((m) => isView(m) && !changedTargets.has(m.target))) {
      if (headDefs.has(view.target)) continue;
      const affected = reads(view, new Set([...baseDefs.keys(), ...headDefs.keys()]));
      if (affected.length === 0) continue;
      const b = baseByTarget.get(view.target);
      if (b !== undefined) baseDefs.set(view.target, inlineViews(b.query, baseDefs));
      headDefs.set(view.target, inlineViews(view.query, headDefs));
      grew = true;
    }
  }

  const affectedViews = new Set([...baseDefs.keys(), ...headDefs.keys()]);
  const shortName = (target: string) => target.split(".").pop() ?? target;
  const inlineChange = (c: ModelChange): ModelChange => {
    if (c.kind === "added") return { ...c, head: withInlined(c.head, headDefs) };
    if (c.kind === "removed") return { ...c, base: withInlined(c.base, baseDefs) };
    return { ...c, base: withInlined(c.base, baseDefs), head: withInlined(c.head, headDefs) };
  };

  const out = changes.map((c) =>
    isView(c.kind === "removed" ? c.base : c.head) ? c : inlineChange(c),
  );
  for (const h of head) {
    if (changedTargets.has(h.target) || isView(h)) continue;
    const b = baseByTarget.get(h.target);
    if (b === undefined) continue;
    const viaViews = reads(h, affectedViews);
    if (viaViews.length === 0) continue;
    out.push({
      kind: "modified",
      target: h.target,
      base: withInlined(b, baseDefs),
      head: withInlined(h, headDefs),
      viaViews: viaViews.map(shortName),
    });
  }
  return out.sort((x, y) => x.target.localeCompare(y.target));
}
