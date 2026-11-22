import type { WorkerCatalog } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { empty, handle, json } from "@/lib/server/http";
import { getCatalog } from "@/lib/server/reference";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET (Bearer WORKER_TOKEN) → WorkerCatalog for the active price list, or 204 when none is loaded. */
export const GET = handle(async (req: Request) => {
  requireWorker(req);
  const c = await getCatalog(sql());
  if (!c) return empty(204);
  const body: WorkerCatalog = { version: c.version, count: c.count, text: c.text };
  return json(body);
});
