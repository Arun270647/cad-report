import type { WorkerTask } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { empty, handle, json } from "@/lib/server/http";
import { MAX_ATTEMPTS, refreshJobStatus } from "@/lib/server/jobs";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function workerInfo(req: Request): string | null {
  const v = req.headers.get("x-worker-info");
  if (!v) return null;
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return clean || null;
}

/**
 * GET (Bearer WORKER_TOKEN) → 200 WorkerTask, or 204 when idle.
 * GET ?probe=1 → 200 {ok:true} after updating the heartbeat (no claim, no stale release).
 */
export const GET = handle(async (req: Request) => {
  requireWorker(req);
  const db = sql();
  const info = workerInfo(req);

  await db`
    INSERT INTO bom.worker_heartbeat (id, last_seen, info) VALUES (1, now(), ${info})
    ON CONFLICT (id) DO UPDATE
      SET last_seen = now(), info = coalesce(EXCLUDED.info, bom.worker_heartbeat.info)`;

  if (new URL(req.url).searchParams.get("probe") === "1") return json({ ok: true });

  // Release stale claims.
  const released = await db<{ job_id: string }[]>`
    UPDATE bom.job_pages
       SET status     = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pending' END,
           error      = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'Timed out on the worker' ELSE error END,
           image      = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE image END,
           claimed_at = NULL,
           updated_at = now()
     WHERE status = 'processing' AND claimed_at < now() - interval '10 minutes'
    RETURNING job_id`;
  for (const jobId of new Set(released.map((r) => r.job_id))) await refreshJobStatus(db, jobId);

  // Atomically claim the oldest pending page.
  const task = await db.begin(async (tx) => {
    const [row] = await tx<{ job_id: string; page: number; attempts: number; media_type: string | null; image: Buffer | null }[]>`
      UPDATE bom.job_pages
         SET status = 'processing', attempts = attempts + 1, claimed_at = now(), updated_at = now()
       WHERE (job_id, page) = (
               SELECT job_id, page FROM bom.job_pages
                WHERE status = 'pending'
                ORDER BY updated_at, page
                LIMIT 1
                FOR UPDATE SKIP LOCKED)
      RETURNING job_id, page, attempts, media_type, image`;
    if (!row) return null;
    if (!row.image || (row.media_type !== "image/png" && row.media_type !== "image/jpeg")) {
      await tx`
        UPDATE bom.job_pages SET status = 'error', error = 'Page image is missing', image = NULL, claimed_at = NULL, updated_at = now()
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

  return task ? json(task) : empty(204);
});
