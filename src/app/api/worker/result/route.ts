import type postgres from "postgres";
import type { PageStatus } from "@/lib/contract";
import { PageZod } from "@/lib/bom/page-schema";
import { sql } from "@/lib/server/db";
import { handle, HttpError, json, parseWith, readJson } from "@/lib/server/http";
import { failureOutcome, refreshJobStatus, WorkerResultZod } from "@/lib/server/jobs";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST WorkerResultRequest (Bearer WORKER_TOKEN) → 200 {ok:true, status}; 404 unknown page; 409 not processing. */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const body = parseWith(WorkerResultZod, await readJson(req, 4_000_000));

  let ok: { result: postgres.JSONValue } | null = null;
  let errorMessage = "";
  let retryable = false;
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
           SET status = 'done', result = ${tx.json(ok.result)}, image = NULL, error = NULL, claimed_at = NULL, updated_at = now()
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
           SET status = 'error', error = ${errorMessage}, image = NULL, claimed_at = NULL, updated_at = now()
         WHERE job_id = ${body.jobId} AND page = ${body.page}`;
    }
    await refreshJobStatus(tx, body.jobId);
    return next;
  });

  return json({ ok: true, status });
});
