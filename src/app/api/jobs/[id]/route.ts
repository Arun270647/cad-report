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
    { page: number; status: PageStatus; skip_reason: string | null; error: string | null; result: PageExtraction | null; attempts: number }[]
  >`
    SELECT page, status, skip_reason, error, CASE WHEN status = 'done' THEN result END AS result, attempts
      FROM bom.job_pages WHERE job_id = ${id} ORDER BY page`;

  // Status is persisted at every write; derive it here with the same rule so a read is always consistent.
  const status = deriveJobStatus(countPages(rows));

  let queuePosition = 0;
  if (status !== "done") {
    // Pending pages from other jobs that the worker will take before this job's first pending page
    // (the worker claims ORDER BY updated_at, page).
    const [q] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bom.job_pages
       WHERE status = 'pending' AND job_id <> ${id}
         AND updated_at < coalesce(
               (SELECT min(updated_at) FROM bom.job_pages WHERE job_id = ${id} AND status = 'pending'),
               now())`;
    queuePosition = q?.n ?? 0;
  }

  const pages: JobPageView[] = rows.map((r) => ({
    page: r.page,
    status: r.status,
    skipReason: r.skip_reason,
    error: r.error,
    result: r.status === "done" ? r.result : null,
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
