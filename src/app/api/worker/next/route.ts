import { NextResponse } from "next/server";
import type { WorkerTask } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, json, NO_STORE } from "@/lib/server/http";
import { MAX_ATTEMPTS, refreshJobStatus } from "@/lib/server/jobs";
import { priceListVersion } from "@/lib/server/reference";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Advisory-lock key that serialises claims: only ONE page is ever being read at a time. */
const CLAIM_LOCK = 4_812_017;

function workerInfo(req: Request): string | null {
  const v = req.headers.get("x-worker-info");
  if (!v) return null;
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return clean || null;
}

/** 204 "nothing for you now", with an optional reason header the worker logs (paused / usage limit). */
function idle(reason?: { paused?: boolean; limitUntil?: Date | null }): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": NO_STORE };
  if (reason?.paused) headers["x-worker-paused"] = "1";
  if (reason?.limitUntil) headers["x-worker-limit-until"] = reason.limitUntil.toISOString();
  return new NextResponse(null, { status: 204, headers });
}

/**
 * GET (Bearer WORKER_TOKEN) → 200 WorkerTask, or 204 when idle / paused / waiting for a usage-limit reset.
 * GET ?probe=1 → 200 {ok:true} after updating the heartbeat (no claim, no stale release).
 * Queue: strictly one page at a time, oldest job first, then page order. Pages waiting for a usage-limit
 * reset become claimable again at retry_at.
 */
export const GET = handle(async (req: Request) => {
  requireWorker(req);
  const db = sql();
  const info = workerInfo(req);

  await db`
    INSERT INTO bom.worker_heartbeat (id, last_seen, last_poll, info) VALUES (1, now(), now(), ${info})
    ON CONFLICT (id) DO UPDATE
      SET last_seen = now(), last_poll = now(), info = coalesce(EXCLUDED.info, bom.worker_heartbeat.info)`;

  if (new URL(req.url).searchParams.get("probe") === "1") return json({ ok: true });

  const [gate] = await db<{ paused: boolean | null; limit_until: Date | null }[]>`
    SELECT (SELECT paused FROM bom.settings WHERE id = 1) AS paused,
           (SELECT limit_until FROM bom.worker_heartbeat WHERE id = 1 AND limit_until > now()) AS limit_until`;
  if (gate?.paused) return idle({ paused: true });
  if (gate?.limit_until) return idle({ limitUntil: new Date(gate.limit_until) });

  // Release stale claims.
  const released = await db<{ job_id: string }[]>`
    UPDATE bom.job_pages
       SET status      = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pending' END,
           error       = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'Timed out on the worker' ELSE error END,
           image       = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE image END,
           finished_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() ELSE finished_at END,
           claimed_at  = NULL,
           updated_at  = now()
     WHERE status = 'processing' AND claimed_at < now() - interval '10 minutes'
    RETURNING job_id`;
  for (const jobId of new Set(released.map((r) => r.job_id))) await refreshJobStatus(db, jobId);

  // Atomically claim the next page — only if nothing else is being read right now.
  const task = await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK})`;
    const [busy] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bom.job_pages WHERE status = 'processing'`;
    if ((busy?.n ?? 0) > 0) return null;
    const [row] = await tx<{ job_id: string; page: number; attempts: number; media_type: string | null; image: Buffer | null }[]>`
      UPDATE bom.job_pages
         SET status = 'processing', attempts = attempts + 1, claimed_at = now(), retry_at = NULL, updated_at = now()
       WHERE (job_id, page) = (
               SELECT p.job_id, p.page
                 FROM bom.job_pages p JOIN bom.jobs j ON j.id = p.job_id
                WHERE p.status = 'pending' OR (p.status = 'waiting_limit' AND p.retry_at <= now())
                ORDER BY j.created_at, p.page
                LIMIT 1
                FOR UPDATE OF p SKIP LOCKED)
      RETURNING job_id, page, attempts, media_type, image`;
    if (!row) return null;
    if (!row.image || (row.media_type !== "image/png" && row.media_type !== "image/jpeg")) {
      await tx`
        UPDATE bom.job_pages
           SET status = 'error', error = 'Page image is missing', image = NULL, claimed_at = NULL, finished_at = now(), updated_at = now()
         WHERE job_id = ${row.job_id} AND page = ${row.page}`;
      await refreshJobStatus(tx, row.job_id);
      return null;
    }
    await refreshJobStatus(tx, row.job_id);
    const t: WorkerTask = {
      jobId: row.job_id,
      page: row.page,
      attempt: row.attempts,
      mediaType: row.media_type,
      data: Buffer.from(row.image).toString("base64"),
    };
    return t;
  });

  if (!task) return idle();
  task.catalogVersion = await priceListVersion(db);
  return json(task);
});
