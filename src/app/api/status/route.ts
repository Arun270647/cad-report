import type { StatusView } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { isAdmin, requireSession } from "@/lib/server/session";
import { computeWorkerState, loadHeartbeat, loadSettings } from "@/lib/server/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const email = requireSession(req);
  const db = sql();
  const hb = await loadHeartbeat(db);
  const { state } = computeWorkerState(hb);
  const { paused } = await loadSettings(db);
  const [p] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bom.job_pages WHERE status IN ('pending', 'waiting_limit')`;
  const lim = hb?.limit_until ? new Date(hb.limit_until) : null;
  const view: StatusView = {
    workerOnline: state !== "offline",
    workerState: state,
    workerLastSeen: hb?.last_seen ? new Date(hb.last_seen).toISOString() : null,
    pendingPages: p?.n ?? 0,
    paused,
    limitUntil: lim && lim.getTime() > Date.now() ? lim.toISOString() : null,
    isAdmin: isAdmin(email),
  };
  return json(view);
});
