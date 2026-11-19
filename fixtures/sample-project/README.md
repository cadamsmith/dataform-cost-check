# sample-project

A minimal Dataform project used in tests: one table (`customers`), one incremental
(`orders_daily`, partitioned, with an incremental filter) and one view (`orders_recent`),
all reading the declared source `raw.orders`.

It is never deployed. The project ID `driftline-sample` is a placeholder.
