// Prints how many rows each table holds per status: `pnpm db:counts`.
//
// For a look at a database before a migration changes its rows: what a
// migration that activates, withdraws or voids by status is about to touch.
// The session is read-only, and the output is table names, statuses and
// counts: no names, amounts or dates.
import pg from "pg";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL });
await db.connect();
await db.query("set default_transaction_read_only = on");

const tables = await db.query<{ table_name: string }>(
  `select table_name from information_schema.columns
   where table_schema = 'public' and column_name = 'status'
   order by table_name`,
);
for (const { table_name } of tables.rows) {
  const counts = await db.query<{ status: string; n: string }>(
    `select status::text, count(*) as n from ${pg.escapeIdentifier(table_name)} group by status order by status`,
  );
  const line = counts.rows.map((r) => `${r.status} ${r.n}`).join(", ");
  console.log(`${table_name}: ${line || "empty"}`);
}
await db.end();
