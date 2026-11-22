import type { StatusView } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  requireSession(req);
  const db = sql();
  const [hb] = await db<{ last_seen: Date | null; online: boolean }[]>`
    SELECT last_seen, coalesce(last_seen > now() - interval '90 seconds', false) AS online
      FROM bom.worker_heartbeat WHERE id = 1`;
  const [p] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bom.job_pages WHERE status = 'pending'`;
  const view: StatusView = {
    workerOnline: hb?.online ?? false,
    workerLastSeen: hb?.last_seen ? new Date(hb.last_seen).toISOString() : null,
    pendingPages: p?.n ?? 0,
  };
  return json(view);
});
