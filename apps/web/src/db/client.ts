import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";
import type { Db } from "./types.ts";

export function connect(databaseUrl = process.env.DATABASE_URL): { db: Db; pool: pg.Pool } {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  return { db: drizzle(pool, { schema }), pool };
}

// One pool per server process. Kept on globalThis so dev hot reloads reuse it.
const globalForDb = globalThis as typeof globalThis & { __abacusDb?: Db };

export function getDb(): Db {
  globalForDb.__abacusDb ??= connect().db;
  return globalForDb.__abacusDb;
}
