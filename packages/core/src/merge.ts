/**
 * The MERGE statement Dataform runs for an incremental model with a `uniqueKey`, copied
 * from Dataform's BigQuery adapter (`mergeInto`, identical in core 2.9.0, CLI 3.0.61 and
 * 3.1.6). `dataform compile --json` does not include it, because the column list comes
 * from the existing table at run time. Kept character for character, whitespace
 * included, so a dry run of it bills what the real run bills. Pure.
 *
 * `target` is `project.dataset.table`; `query` is the incremental query.
 */
export function mergeSql(
  target: string,
  columns: readonly string[],
  query: string,
  uniqueKey: readonly string[],
  updatePartitionFilter: string | undefined,
): string {
  const backtickedColumns = columns.map((column) => `\`${column}\``);
  return `
merge \`${target}\` T
using (${query}
) S
on ${uniqueKey.map((uniqueKeyCol) => `T.${uniqueKeyCol} = S.${uniqueKeyCol}`).join(` and `)}
  ${updatePartitionFilter ? `and T.${updatePartitionFilter}` : ""}
when matched then
  update set ${columns.map((column) => `\`${column}\` = S.${column}`).join(",")}
when not matched then
  insert (${backtickedColumns.join(",")}) values (${backtickedColumns.join(",")})`;
}
