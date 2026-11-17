import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";

// Driver-agnostic handle: node-postgres in the app, PGlite in tests. A
// transaction handle satisfies it too.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
