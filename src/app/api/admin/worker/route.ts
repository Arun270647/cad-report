import { z } from "zod";
import type { AdminAlert, AdminJobRow, AdminWorkerView, JobStatus } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, json, parseWith, readJson } from "@/lib/server/http";
import { requireAdmin } from "@/lib/server/session";
import { computeWorkerState, loadHeartbeat, loadSettings } from "@/lib/server/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** GET → AdminWorkerView (admins only). */
export const GET = handle(async (req: Request) => {
  requireAdmin(req);
  const db = sql();
  const hb = await loadHeartbeat(db);
  const settings = await loadSettings(db);
  const { state, reasons } = computeWorkerState(hb);

  const [q] = await db<{ pending: number; processing: number; waiting: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'processing')::int AS processing,
           count(*) FILTER (WHERE status = 'waiting_limit')::int AS waiting
      FROM bom.job_pages`;

  const jobs = await db<
    { id: string; filename: string; email: string; status: JobStatus; created_at: Date; pages: number; done: number; errors: number; waiting: number; unfinished: number; claude_ms: number; last_finished: Date | null; last_error: string | null }[]
  >`
    SELECT j.id, j.filename, j.email, j.status, j.created_at,
           count(*) FILTER (WHERE p.status <> 'skipped')::int AS pages,
           count(*) FILTER (WHERE p.status = 'done')::int AS done,
           count(*) FILTER (WHERE p.status = 'error')::int AS errors,
           count(*) FILTER (WHERE p.status = 'waiting_limit')::int AS waiting,
           count(*) FILTER (WHERE p.status IN ('awaiting_upload', 'pending', 'processing', 'waiting_limit'))::int AS unfinished,
           coalesce(sum(p.duration_ms), 0)::bigint::float8 AS claude_ms,
           max(p.finished_at) AS last_finished,
           (array_agg(p.error ORDER BY p.updated_at DESC) FILTER (WHERE p.error IS NOT NULL))[1] AS last_error
      FROM bom.jobs j LEFT JOIN bom.job_pages p ON p.job_id = j.id
     GROUP BY j.id
     ORDER BY j.created_at DESC
     LIMIT 20`;

  const alerts = await db<{ kind: string; message: string; opened_at: Date; resolved_at: Date | null }[]>`
    (SELECT kind, message, opened_at, resolved_at FROM bom.worker_alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC)
    UNION ALL
    (SELECT kind, message, opened_at, resolved_at FROM bom.worker_alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 10)`;

  const view: AdminWorkerView = {
    state,
    reasons,
    lastSeen: iso(hb?.last_seen),
    lastPoll: iso(hb?.last_poll),
    host: hb?.info?.split(" ")[0] ?? null,
    nodeVersion: hb?.node_version ?? null,
    claudeVersion: hb?.claude_version ?? null,
    loginOk: hb?.login_ok ?? null,
    loginDetail: hb?.login_detail ?? null,
    limitUntil: hb?.limit_until && new Date(hb.limit_until).getTime() > Date.now() ? iso(hb.limit_until) : null,
    lastError: hb?.last_error ?? null,
    startedAt: iso(hb?.started_at),
    paused: settings.paused,
    pausedBy: settings.paused_by,
    pausedAt: iso(settings.paused_at),
    queue: { pending: q?.pending ?? 0, processing: q?.processing ?? 0, waitingLimit: q?.waiting ?? 0 },
    jobs: jobs.map(
      (j): AdminJobRow => ({
        id: j.id,
        filename: j.filename,
        email: j.email,
        status: j.status,
        createdAt: new Date(j.created_at).toISOString(),
        pages: j.pages,
        done: j.done,
        errors: j.errors,
        waiting: j.waiting,
        claudeMs: Number(j.claude_ms) || 0,
        wallMs: j.unfinished === 0 && j.last_finished ? new Date(j.last_finished).getTime() - new Date(j.created_at).getTime() : null,
        lastError: j.last_error,
      }),
    ),
    alerts: alerts.map((a): AdminAlert => ({ kind: a.kind, message: a.message, openedAt: new Date(a.opened_at).toISOString(), resolvedAt: iso(a.resolved_at) })),
  };
  return json(view);
});

const ActionZod = z.object({ action: z.enum(["pause", "resume"]) });

/** POST {action: "pause" | "resume"} → { ok: true, paused } (admins only). Pausing never interrupts the page being read. */
export const POST = handle(async (req: Request) => {
  const email = requireAdmin(req);
  const { action } = parseWith(ActionZod, await readJson(req, 1_000));
  const db = sql();
  const paused = action === "pause";
  await db`
    INSERT INTO bom.settings (id, paused, paused_by, paused_at) VALUES (1, ${paused}, ${paused ? email : null}, ${paused ? new Date() : null})
    ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused, paused_by = EXCLUDED.paused_by, paused_at = EXCLUDED.paused_at`;
  return json({ ok: true, paused });
});
