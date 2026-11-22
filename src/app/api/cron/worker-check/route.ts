import { sql } from "@/lib/server/db";
import { handle, HttpError, json } from "@/lib/server/http";
import { safeEqual } from "@/lib/server/session";
import { computeWorkerState, loadHeartbeat, openAlert, resolveAlert } from "@/lib/server/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET (Authorization: Bearer CRON_SECRET) — called every 5 min by .github/workflows/worker-check.yml.
 * Opens an "offline" alert when there has been no heartbeat for 5 minutes, resolves it when the worker is back.
 */
export const GET = handle(async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) throw new HttpError(503, "not_configured", "CRON_SECRET is not configured");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || !safeEqual(m[1] as string, secret)) throw new HttpError(401, "unauthorized", "Invalid cron secret");

  const db = sql();
  const hb = await loadHeartbeat(db);
  const { state, reasons } = computeWorkerState(hb);
  if (state === "offline") await openAlert(db, "offline", `PC worker offline: ${reasons.join("; ")}`);
  else await resolveAlert(db, "offline");
  return json({ ok: true, state, reasons });
});
