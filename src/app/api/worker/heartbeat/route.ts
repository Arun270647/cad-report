import { sql } from "@/lib/server/db";
import { handle, json, parseWith, readJson } from "@/lib/server/http";
import { WorkerHeartbeatZod } from "@/lib/server/jobs";
import { loadSettings, openAlert, resolveAlert } from "@/lib/server/worker-status";
import { requireWorker } from "@/lib/server/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const oneLine = (s: string | null) => (s == null ? null : s.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null);

/** POST WorkerHeartbeatRequest (Bearer WORKER_TOKEN, every 60 s) → { ok: true, paused }. */
export const POST = handle(async (req: Request) => {
  requireWorker(req);
  const hb = parseWith(WorkerHeartbeatZod, await readJson(req, 10_000));
  const db = sql();
  const limitUntil = hb.limitUntil && Date.parse(hb.limitUntil) > Date.now() ? new Date(hb.limitUntil) : null;
  const info = oneLine(`${hb.host} claude ${hb.claudeVersion}`)?.slice(0, 200) ?? null;

  await db`
    INSERT INTO bom.worker_heartbeat
      (id, last_seen, info, node_version, claude_version, login_ok, login_detail, limit_until, last_poll, last_error, started_at)
    VALUES (1, now(), ${info}, ${oneLine(hb.nodeVersion)}, ${oneLine(hb.claudeVersion)}, ${hb.loginOk}, ${oneLine(hb.loginDetail)},
            ${limitUntil}, ${hb.lastPollAt ? new Date(hb.lastPollAt) : null}, ${oneLine(hb.lastError)}, ${new Date(hb.startedAt)})
    ON CONFLICT (id) DO UPDATE SET
      last_seen = now(), info = EXCLUDED.info, node_version = EXCLUDED.node_version, claude_version = EXCLUDED.claude_version,
      login_ok = EXCLUDED.login_ok, login_detail = EXCLUDED.login_detail, limit_until = EXCLUDED.limit_until,
      last_poll = greatest(bom.worker_heartbeat.last_poll, EXCLUDED.last_poll), last_error = EXCLUDED.last_error,
      started_at = EXCLUDED.started_at`;

  await resolveAlert(db, "offline");
  if (hb.loginOk === false) {
    await openAlert(db, "logout", `Claude Code on ${hb.host} is logged out (${oneLine(hb.loginDetail) ?? "auth status"}). Run \`claude\` and /login.`);
  } else if (hb.loginOk === true) {
    await resolveAlert(db, "logout");
  }
  if (limitUntil) {
    await openAlert(db, "usage_limit", `Claude Code plan usage limit. Conversions resume automatically after ${limitUntil.toISOString()}.`);
  } else {
    await resolveAlert(db, "usage_limit");
  }

  const { paused } = await loadSettings(db);
  return json({ ok: true, paused });
});
