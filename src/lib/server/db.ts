import "server-only";
import postgres from "postgres";
import { HttpError } from "./http";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or a transaction (TransactionSql extends Sql). */
export type Db = Sql;

const g = globalThis as unknown as { __bomSql?: Sql };

/**
 * Lazy postgres.js client. Nothing connects at import/build time; the pool is created on first use
 * and cached on globalThis (survives hot reloads / warm lambdas). Supabase transaction pooler => prepare:false.
 */
export function sql(): Sql {
  if (g.__bomSql) return g.__bomSql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, "not_configured", "Database is not configured on the server");
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  const hasSslMode = /[?&]sslmode=/.test(url);
  g.__bomSql = postgres(url, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(hasSslMode || local ? {} : { ssl: "require" as const }),
    onnotice: () => {},
  });
  return g.__bomSql;
}
