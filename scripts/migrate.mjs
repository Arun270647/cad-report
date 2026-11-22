// Applies Drizzle SQL migrations (drizzle/) before `next build`. Uses DATABASE_URL from the environment.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  if (process.env.VERCEL) {
    console.error("[migrate] DATABASE_URL is not set — aborting build.");
    process.exit(1);
  }
  console.warn("[migrate] DATABASE_URL not set — skipping migrations (local build).");
  process.exit(0);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle", migrationsSchema: "bom", migrationsTable: "__migrations" });
  console.log("[migrate] migrations applied");
} catch (e) {
  console.error("[migrate] failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
