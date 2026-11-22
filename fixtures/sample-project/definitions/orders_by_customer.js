// Actions defined in JavaScript, as some teams write them alongside SQLX files.

// An incremental that sets a checkpoint in pre-operations and filters on it, the shape a
// dry run cannot size.
publish("orders_by_customer", {
  type: "incremental",
  description: "Orders per customer per day, appended from a checkpoint.",
  bigquery: { partitionBy: "order_date" },
})
  .preOps(
    (ctx) =>
      `DECLARE checkpoint DATE DEFAULT (${
        ctx.incremental() ? `SELECT MAX(order_date) FROM ${ctx.self()}` : `SELECT DATE '2000-01-01'`
      })`,
  )
  .query(
    (ctx) => `SELECT order_date, customer_id, COUNT(*) AS orders
FROM ${ctx.ref("orders")}
${ctx.incremental() ? "WHERE order_date > checkpoint" : ""}
GROUP BY order_date, customer_id`,
  );

operate("drop_stale_orders")
  .dependencies(["orders_by_customer"])
  .queries(
    (ctx) =>
      `DELETE FROM ${ctx.ref("orders_by_customer")} WHERE order_date < DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY)`,
  );
