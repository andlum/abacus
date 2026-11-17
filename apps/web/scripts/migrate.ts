// Applies pending migrations from ./drizzle. Runs locally via `pnpm db:migrate`
// and on every deploy, before the new version starts (`node scripts/migrate.ts`).
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connect } from "../src/db/client.ts";

// A pooled URL usually goes through PgBouncer, which migrations can't rely on,
// so use the direct URL when one is set.
const { db, pool } = connect(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrations applied");
