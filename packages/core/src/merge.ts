/**
 * The MERGE statement Dataform runs for an incremental model with a `uniqueKey`, copied
 * from Dataform's BigQuery `mergeInto` in CLI 3.1.x (3.1.6 and 3.1.7), whitespace
 * included. `dataform compile --json` does not include it, because the column list comes
 * from the existing table at run time. Older versions (CLI 3.0.x, core 2.x) name the
 * aliases `T` and `S`, place the update filter on its own line, and have no
 * `incrementalPredicates`; the statement is otherwise the same, and aliases and
 * whitespace do not change the bytes a dry run counts. Pure.
 *
 * `target` is `project.dataset.table`; `query` is the incremental query.
 */
export function mergeSql(
  target: string,
  columns: readonly string[],
  query: string,
  uniqueKey: readonly string[],
  options: {
    readonly updatePartitionFilter?: string | undefined;
    readonly incrementalPredicates?: readonly string[] | undefined;
  } = {},
): string {
  const { updatePartitionFilter } = options;
  const incrementalPredicatesString = predicatesString(options.incrementalPredicates);
  const backtickedColumns = columns.map((column) => `\`${column}\``);
  return `
merge \`${target}\` DATAFORM_DEST
using (${query}
) DATAFORM_SOURCE
on ${uniqueKey.map((uniqueKeyCol) => `DATAFORM_DEST.${uniqueKeyCol} = DATAFORM_SOURCE.${uniqueKeyCol}`).join(` and `)} ${updatePartitionFilter ? `and DATAFORM_DEST.${updatePartitionFilter}` : ""}
${incrementalPredicatesString ? ` ${incrementalPredicatesString}` : ""}
when matched then
  update set ${columns.map((column) => `\`${column}\` = DATAFORM_SOURCE.${column}`).join(",")}
when not matched then
  insert (${backtickedColumns.join(",")}) values (${backtickedColumns.join(",")})`;
}

/** Dataform's `buildIncrementalPredicatesString`. */
function predicatesString(incrementalPredicates: readonly string[] | undefined): string {
  const validPredicates = incrementalPredicates
    ? incrementalPredicates.filter((p) => p.trim() !== "")
    : [];
  if (validPredicates.length === 0) {
    return "";
  }
  return `and ${validPredicates.map((p) => `(${p})`).join(" and ")}`;
}
