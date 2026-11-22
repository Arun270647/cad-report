import type { CreateJobResponse } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, HttpError, json, parseWith, readJson } from "@/lib/server/http";
import { CreateJobZod, deriveJobStatus, JOB_RETENTION_DAYS, JOBS_PER_HOUR, planJob, type JobSummary, type PageCounts } from "@/lib/server/jobs";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST CreateJobRequest → 201 CreateJobResponse. */
export const POST = handle(async (req: Request) => {
  const email = requireSession(req);
  const input = parseWith(CreateJobZod, await readJson(req, 200_000));
  const plan = planJob(input);
  const db = sql();

  await db`DELETE FROM bom.jobs WHERE created_at < now() - make_interval(days => ${JOB_RETENTION_DAYS})`;

  const [recent] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bom.jobs WHERE email = ${email} AND created_at > now() - interval '1 hour'`;
  if ((recent?.n ?? 0) >= JOBS_PER_HOUR) {
    throw new HttpError(429, "rate_limited", `At most ${JOBS_PER_HOUR} jobs per hour. Try again later.`);
  }

  const id = await db.begin(async (tx) => {
    const [job] = await tx<{ id: string }[]>`
      INSERT INTO bom.jobs (email, filename, status, page_count)
      VALUES (${email}, ${input.filename}, ${plan.status}, ${plan.pageCount})
      RETURNING id`;
    if (!job) throw new Error("job insert returned no row");
    const rows = plan.pages.map((p) => ({ job_id: job.id, page: p.page, status: p.status, skip_reason: p.skipReason }));
    await tx`INSERT INTO bom.job_pages ${tx(rows, "job_id", "page", "status", "skip_reason")}`;
    return job.id;
  });

  const body: CreateJobResponse = { id };
  return json(body, 201);
});

/** GET → { jobs: JobSummary[] } (the caller's 20 most recent jobs). */
export const GET = handle(async (req: Request) => {
  const email = requireSession(req);
  const rows = await sql()<
    {
      id: string; filename: string; created_at: Date; page_count: number;
      skipped: number; awaiting_upload: number; pending: number; processing: number; done: number; error: number; started: number;
    }[]
  >`
    SELECT j.id, j.filename, j.created_at, j.page_count,
           count(*) FILTER (WHERE p.status = 'skipped')::int         AS skipped,
           count(*) FILTER (WHERE p.status = 'awaiting_upload')::int AS awaiting_upload,
           count(*) FILTER (WHERE p.status = 'pending')::int         AS pending,
           count(*) FILTER (WHERE p.status = 'processing')::int      AS processing,
           count(*) FILTER (WHERE p.status = 'done')::int            AS done,
           count(*) FILTER (WHERE p.status = 'error')::int           AS error,
           count(*) FILTER (WHERE p.attempts > 0)::int               AS started
      FROM bom.jobs j
      LEFT JOIN bom.job_pages p ON p.job_id = j.id
     WHERE j.email = ${email}
     GROUP BY j.id
     ORDER BY j.created_at DESC
     LIMIT 20`;
  const jobs: JobSummary[] = rows.map((r) => {
    const counts: PageCounts = {
      skipped: r.skipped, awaiting_upload: r.awaiting_upload, pending: r.pending,
      processing: r.processing, done: r.done, error: r.error, started: r.started,
    };
    const { started: _started, ...visible } = counts;
    return {
      id: r.id,
      filename: r.filename,
      status: deriveJobStatus(counts),
      createdAt: new Date(r.created_at).toISOString(),
      pageCount: r.page_count,
      counts: visible,
    };
  });
  return json({ jobs });
});
