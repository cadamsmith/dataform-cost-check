# sample-project

A minimal Dataform project used in tests: one table (`customers`), one incremental
(`orders_daily`, partitioned, with an incremental filter) and one view (`orders_recent`),
all reading the declared source `raw.orders`. It also has one assertion
(`customers_unique`) and one operation (`grant_readers`), so every action type is covered.
`orders_by_customer.js` defines actions in JavaScript, as some teams do alongside SQLX: an
incremental that filters on a checkpoint declared in pre-operations, and an `operate()`.

It is never deployed. The project ID `cost-check-sample` is a placeholder.

`packages/dataform/test/fixtures/sample-compile.json` is a saved copy of
`dataform compile --json` run here. Regenerate it after changing the project:

```sh
cd fixtures/sample-project
dataform compile --json > ../../packages/dataform/test/fixtures/sample-compile.json
pnpm prettier --write ../../packages/dataform/test/fixtures/sample-compile.json
```
