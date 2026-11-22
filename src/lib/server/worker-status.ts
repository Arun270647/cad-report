import "server-only";
import type { WorkerState } from "@/lib/contract";
import type { Db } from "./db";

/** Heartbeat every 60 s: late after 150 s (degraded), offline after 5 min (alert). */
export const HEARTBEAT_LATE_MS = 150_000;
export const HEARTBEAT_OFFLINE_MS = 5 * 60_000;

export interface HeartbeatRow {
  last_seen: Date | null;
  last_poll: Date | null;
  info: string | null;
  node_version: string | null;
  claude_version: string | null;
  login_ok: boolean | null;
  login_detail: string | null;
  limit_until: Date | null;
  last_error: string | null;
  started_at: Date | null;
}

/** Online / Degraded / Offline with human-readable reasons. Pure — unit tested. */
export function computeWorkerState(
  hb: Pick<HeartbeatRow, "last_seen" | "login_ok" | "limit_until"> | null | undefined,
  now = Date.now(),
): { state: WorkerState; reasons: string[] } {
  const seen = hb?.last_seen ? new Date(hb.last_seen).getTime() : null;
  if (seen === null) return { state: "offline", reasons: ["The worker has never checked in"] };
  const age = now - seen;
  if (age > HEARTBEAT_OFFLINE_MS) return { state: "offline", reasons: [`No heartbeat for ${Math.round(age / 60_000)} min`] };
  const reasons: string[] = [];
  if (age > HEARTBEAT_LATE_MS) reasons.push(`Heartbeat late (${Math.round(age / 1000)} s)`);
  if (hb?.login_ok === false) reasons.push("Claude Code is logged out on the PC — run `claude` and /login");
  const lim = hb?.limit_until ? new Date(hb.limit_until).getTime() : null;
  if (lim !== null && lim > now) reasons.push(`Claude usage limit — resumes at ${new Date(lim).toISOString()}`);
  return { state: reasons.length ? "degraded" : "online", reasons };
}

export async function loadHeartbeat(db: Db): Promise<HeartbeatRow | null> {
  const [hb] = await db<HeartbeatRow[]>`
    SELECT last_seen, last_poll, info, node_version, claude_version, login_ok, login_detail, limit_until, last_error, started_at
      FROM bom.worker_heartbeat WHERE id = 1`;
  return hb ?? null;
}

export async function loadSettings(db: Db): Promise<{ paused: boolean; paused_by: string | null; paused_at: Date | null }> {
  const [s] = await db<{ paused: boolean; paused_by: string | null; paused_at: Date | null }[]>`
    SELECT paused, paused_by, paused_at FROM bom.settings WHERE id = 1`;
  return s ?? { paused: false, paused_by: null, paused_at: null };
}

/* ---------- alerts (dashboard now; email can be plugged into notify() later) ---------- */

export type AlertKind = "offline" | "logout" | "usage_limit";

/**
 * Delivery hook for new alerts. Email is not configured yet (decision: dashboard only), so this only logs.
 * To add email later: send here and set worker_alerts.notified_at for the row.
 */
async function notify(kind: AlertKind, message: string): Promise<void> {
  console.info(`[alert] ${kind}: ${message}`);
}

/** Open an alert of this kind unless one is already open. Returns true when newly opened. */
export async function openAlert(db: Db, kind: AlertKind, message: string): Promise<boolean> {
  const rows = await db<{ id: number }[]>`
    INSERT INTO bom.worker_alerts (kind, message) VALUES (${kind}, ${message.slice(0, 500)})
    ON CONFLICT (kind) WHERE resolved_at IS NULL DO NOTHING
    RETURNING id`;
  if (rows.length) await notify(kind, message);
  return rows.length > 0;
}

export async function resolveAlert(db: Db, kind: AlertKind): Promise<void> {
  await db`UPDATE bom.worker_alerts SET resolved_at = now() WHERE kind = ${kind} AND resolved_at IS NULL`;
}
