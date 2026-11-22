import "server-only";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

type DB = PostgresJsDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __db: DB | undefined;
}

function getDb(): DB {
  if (globalThis.__db) return globalThis.__db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // prepare:false keeps us compatible with transaction-mode poolers (Supabase/Neon).
  const client = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 15 });
  globalThis.__db = drizzle(client, { schema });
  return globalThis.__db;
}

/** Lazily-connected Drizzle instance (no connection is opened at build time). */
export const db = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb();
    const v = Reflect.get(real, prop, real);
    return typeof v === "function" ? v.bind(real) : v;
  },
});
export { schema };
