import type postgres from "postgres";
import type { PageStatus } from "@/lib/contract";
import { PageZod } from "@/lib/bom/page-schema";
import { sql } from "@/lib/server/db";
import { handle, HttpError, json, parseWith, readJson } from "@/lib/server/http";
import { failureOutcome, refreshJobStatus, resolveRetryAt, WorkerResultZod } from "@/lib/server/jobs";
import { openAlert, resolveAlert } from "@/lib/server/worker-status";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST WorkerResultRequest (Bearer WORKER_TOKEN) → 200 {ok:true, status}; 404 unknown page; 409 not processing.
 * kind "usage_limit": page → waiting_limit until retryAt (attempt not counted) and the whole queue holds until then.
 * kind "auth": page → pending (attempt not counted); the worker is logged out, so nothing else would succeed either.
 */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const body = parseWith(WorkerResultZod, await readJson(req, 4_000_000));
  const durationMs = body.durationMs != null ? Math.min(2_147_000_000, Math.round(body.durationMs)) : null;

  let ok: { result: postgres.JSONValue } | null = null;
  let errorMessage = "";
  let retryable = false;
  const kind = body.ok ? null : (body.kind ?? null);
  if (body.ok) {
    const parsed = PageZod.safeParse(body.result);
    if (parsed.success) ok = { result: parsed.data as postgres.JSONValue };
    else {
      errorMessage = "Invalid extraction output";
      retryable = true;
    }
  } else {
    errorMessage = body.error.trim().slice(0, 500) || "Extraction failed";
    retryable = body.retryable;
  }

  const db = sql();
  const retryAt = kind === "usage_limit" ? resolveRetryAt(body.ok ? null : body.retryAt) : null;
  const status = await db.begin(async (tx) => {
    const [page] = await tx<{ status: PageStatus; attempts: number }[]>`
      SELECT status, attempts FROM bom.job_pages WHERE job_id = ${body.jobId} AND page = ${body.page} FOR UPDATE`;
    if (!page) throw new HttpError(404, "not_found", "Page not found");
    if (page.status !== "processing") throw new HttpError(409, "conflict", `Page is ${page.status}, not processing`);

    let next: PageStatus;
    if (ok) {
      next = "done";
      await tx`
        UPDATE bom.job_pages
           SET status = 'done', result = ${tx.json(ok.result)}, image = NULL, error = NULL, claimed_at = NULL,
               duration_ms = ${durationMs}, finished_at = now(), updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    } else if (retryAt) {
      next = "waiting_limit";
      await tx`
        UPDATE bom.job_pages
           SET status = 'waiting_limit', retry_at = ${retryAt}, attempts = greatest(attempts - 1, 0),
               error = ${`Waiting – Claude usage limit (retry after ${retryAt.toISOString()})`}, claimed_at = NULL, updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    } else if (kind === "auth") {
      next = "pending";
      await tx`
        UPDATE bom.job_pages
           SET status = 'pending', attempts = greatest(attempts - 1, 0), error = ${errorMessage}, claimed_at = NULL, updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    } else if (failureOutcome(retryable, page.attempts) === "pending") {
      next = "pending";
      await tx`
        UPDATE bom.job_pages
           SET status = 'pending', error = ${errorMessage}, claimed_at = NULL, updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    } else {
      next = "error";
      await tx`
        UPDATE bom.job_pages
           SET status = 'error', error = ${errorMessage}, image = NULL, claimed_at = NULL,
               duration_ms = ${durationMs}, finished_at = now(), updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    }
    await refreshJobStatus(tx, body.jobId);

    // Worker-level state that this result proves.
    if (ok) {
      await tx`UPDATE bom.worker_heartbeat SET login_ok = true, limit_until = NULL WHERE id = 1`;
    } else if (retryAt) {
      await tx`UPDATE bom.worker_heartbeat SET limit_until = ${retryAt} WHERE id = 1`;
    } else if (kind === "auth") {
      await tx`UPDATE bom.worker_heartbeat SET login_ok = false, login_detail = 'Not logged in (reported by a conversion)' WHERE id = 1`;
    }
    return next;
  });

  if (ok) {
    await resolveAlert(db, "usage_limit");
    await resolveAlert(db, "logout");
  } else if (retryAt) {
    await openAlert(db, "usage_limit", `Claude Code reported its plan usage limit. Conversions resume automatically after ${retryAt.toISOString()}.`);
  } else if (kind === "auth") {
    await openAlert(db, "logout", "Claude Code on the PC is logged out. Run `claude` on the PC and /login with the claude.ai account.");
  }

  return json({ ok: true, status });
});
