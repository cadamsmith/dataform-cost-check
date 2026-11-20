import type { Model, ModelChange } from "./types.ts";

/**
 * Compare two compilations by target. A model is changed if it is new, removed,
 * or any SQL that would run differs. Output is sorted by target for stable reports.
 */
export function diffModels(base: readonly Model[], head: readonly Model[]): ModelChange[] {
  const baseByTarget = indexByTarget(base, "base");
  const headByTarget = indexByTarget(head, "head");
  const changes: ModelChange[] = [];

  for (const [target, h] of headByTarget) {
    const b = baseByTarget.get(target);
    if (b === undefined) changes.push({ kind: "added", target, head: h });
    else if (sqlDiffers(b, h)) changes.push({ kind: "modified", target, base: b, head: h });
  }
  for (const [target, b] of baseByTarget) {
    if (!headByTarget.has(target)) changes.push({ kind: "removed", target, base: b });
  }

  return changes.sort((x, y) => x.target.localeCompare(y.target));
}

function sqlDiffers(a: Model, b: Model): boolean {
  return (
    a.type !== b.type ||
    a.query !== b.query ||
    a.incrementalQuery !== b.incrementalQuery ||
    !sameStatements(a.preOps, b.preOps) ||
    !sameStatements(a.incrementalPreOps, b.incrementalPreOps)
  );
}

function sameStatements(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function indexByTarget(models: readonly Model[], side: string): Map<string, Model> {
  const map = new Map<string, Model>();
  for (const m of models) {
    if (map.has(m.target)) throw new Error(`Duplicate target in ${side}: ${m.target}`);
    map.set(m.target, m);
  }
  return map;
}
