import type { JobPageView, JobView, PageStatus } from "@/lib/contract";
import type { PageExtraction } from "@/lib/bom/types";
import { sql } from "@/lib/server/db";
import { handle, HttpError, json } from "@/lib/server/http";
import { countPages, deriveJobStatus, isUuid } from "@/lib/server/jobs";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET → JobView (404 unless the job belongs to the session email). */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const email = requireSession(req);
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Job not found");
  const db = sql();

  const [job] = await db<{ id: string; filename: string; created_at: Date }[]>`
    SELECT id, filename, created_at FROM bom.jobs WHERE id = ${id} AND email = ${email}`;
  if (!job) throw new HttpError(404, "not_found", "Job not found");

  const rows = await db<
    { page: number; status: PageStatus; skip_reason: string | null; error: string | null; result: PageExtraction | null; attempts: number; retry_at: Date | null }[]
  >`
    SELECT page, status, skip_reason, error, CASE WHEN status = 'done' THEN result END AS result, attempts, retry_at
      FROM bom.job_pages WHERE job_id = ${id} ORDER BY page`;

  // Status is persisted at every write; derive it here with the same rule so a read is always consistent.
  const status = deriveJobStatus(countPages(rows));

  let queuePosition = 0;
  if (status !== "done") {
    // The worker reads one page at a time, oldest job first: count queued pages of older jobs.
    const [q] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM bom.job_pages p JOIN bom.jobs j ON j.id = p.job_id
       WHERE p.status IN ('pending', 'processing', 'waiting_limit') AND p.job_id <> ${id}
         AND j.created_at < ${job.created_at}`;
    queuePosition = q?.n ?? 0;
  }

  const pages: JobPageView[] = rows.map((r) => ({
    page: r.page,
    status: r.status,
    skipReason: r.skip_reason,
    error: r.status === "waiting_limit" ? null : r.error,
    result: r.status === "done" ? r.result : null,
    retryAt: r.status === "waiting_limit" && r.retry_at ? new Date(r.retry_at).toISOString() : null,
  }));
  const view: JobView = {
    id: job.id,
    filename: job.filename,
    status,
    createdAt: new Date(job.created_at).toISOString(),
    pages,
    queuePosition,
  };
  return json(view);
});
