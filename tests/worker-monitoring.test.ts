/** Worker monitoring, usage-limit handling and the one-at-a-time queue rules (pure logic; no database). */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const jobs = await import("@/lib/server/jobs");
const { computeWorkerState, HEARTBEAT_OFFLINE_MS } = await import("@/lib/server/worker-status");
const session = await import("@/lib/server/session");
// @ts-ignore plain JS worker (types in worker.d.mts)
const worker = await import("../worker/worker.mjs");

const counts = (o: Partial<Parameters<typeof jobs.deriveJobStatus>[0]>) =>
  jobs.deriveJobStatus({ skipped: 0, awaiting_upload: 0, pending: 0, processing: 0, waiting_limit: 0, done: 0, error: 0, started: 0, ...o });

describe("job status with usage-limit waiting", () => {
  it("is waiting_limit only when nothing is being read and some page waits for a reset", () => {
    expect(counts({ waiting_limit: 1, done: 2 })).toBe("waiting_limit");
    expect(counts({ waiting_limit: 1, pending: 2 })).toBe("waiting_limit");
    expect(counts({ waiting_limit: 1, processing: 1 })).toBe("processing");
    expect(counts({ waiting_limit: 1, awaiting_upload: 1 })).toBe("uploading");
    expect(counts({ done: 3 })).toBe("done");
  });
  it("is never done while a page waits for a reset", () => {
    expect(counts({ waiting_limit: 1, done: 5, error: 1 })).not.toBe("done");
  });
  it("counts waiting_limit pages", () => {
    const c = jobs.countPages([{ status: "waiting_limit", attempts: 0 }, { status: "done", attempts: 1 }]);
    expect(c.waiting_limit).toBe(1);
    expect(jobs.deriveJobStatus(c)).toBe("waiting_limit");
  });
  it("still accepts callers that do not know waiting_limit", () => {
    expect(jobs.deriveJobStatus({ skipped: 0, awaiting_upload: 0, pending: 0, processing: 0, done: 1, error: 0, started: 1 })).toBe("done");
  });
});

describe("usage-limit retry time from the worker", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  it("uses the stated reset, clamped to 1 min … 8 days", () => {
    expect(jobs.resolveRetryAt("2026-11-22T15:00:00Z", now).toISOString()).toBe("2026-11-22T15:00:00.000Z");
    expect(jobs.resolveRetryAt("2026-11-22T11:00:00Z", now).getTime()).toBe(now + 60_000);
    expect(jobs.resolveRetryAt("2027-06-01T00:00:00Z", now).getTime()).toBe(now + 8 * 24 * 3600_000);
  });
  it("waits 30 min when no reset was stated", () => {
    expect(jobs.resolveRetryAt(undefined, now).getTime()).toBe(now + 30 * 60_000);
    expect(jobs.resolveRetryAt("garbage", now).getTime()).toBe(now + 30 * 60_000);
  });
  it("accepts usage_limit results with retryAt", () => {
    const r = jobs.WorkerResultZod.safeParse({
      jobId: "11111111-2222-3333-4444-555555555555", page: 2, ok: false, error: "limit", retryable: true,
      kind: "usage_limit", retryAt: "2026-11-22T15:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });
});

describe("worker state (Online / Degraded / Offline)", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const hb = (o: { ageMs?: number | null; login_ok?: boolean | null; limitInMs?: number | null }) => ({
    last_seen: o.ageMs == null ? null : new Date(now - o.ageMs),
    login_ok: o.login_ok ?? true,
    limit_until: o.limitInMs == null ? null : new Date(now + o.limitInMs),
  });
  it("online with a fresh heartbeat and a valid login", () => {
    expect(computeWorkerState(hb({ ageMs: 30_000 }), now)).toEqual({ state: "online", reasons: [] });
  });
  it("offline after 5 minutes without a heartbeat, or never seen", () => {
    expect(computeWorkerState(hb({ ageMs: HEARTBEAT_OFFLINE_MS + 1000 }), now).state).toBe("offline");
    expect(computeWorkerState(hb({ ageMs: null }), now).state).toBe("offline");
    expect(computeWorkerState(null, now).state).toBe("offline");
  });
  it("degraded when logged out, usage-limited or the heartbeat is late", () => {
    expect(computeWorkerState(hb({ ageMs: 30_000, login_ok: false }), now)).toMatchObject({ state: "degraded", reasons: [expect.stringMatching(/logged out/)] });
    expect(computeWorkerState(hb({ ageMs: 30_000, limitInMs: 3600_000 }), now)).toMatchObject({ state: "degraded", reasons: [expect.stringMatching(/usage limit/)] });
    expect(computeWorkerState(hb({ ageMs: 200_000 }), now).state).toBe("degraded");
  });
  it("an expired limit no longer degrades", () => {
    expect(computeWorkerState(hb({ ageMs: 30_000, limitInMs: -1000 }), now).state).toBe("online");
  });
});

describe("admin access", () => {
  it("only ADMIN_EMAILS (case-insensitive) are admins; empty list means nobody", () => {
    expect(session.isAdmin("Owner@Example.com", ["owner@example.com"])).toBe(true);
    expect(session.isAdmin("user@example.com", ["owner@example.com"])).toBe(false);
    expect(session.isAdmin("owner@example.com", [])).toBe(false);
  });
});

describe("worker: plan usage-limit messages", () => {
  const now = new Date(2026, 10, 22, 10, 15, 0); // local time, 10:15
  it("parses the epoch form", () => {
    expect(worker.parseLimitReset("Claude AI usage limit reached|1764000000", now)?.getTime()).toBe(1764000000 * 1000);
  });
  it("parses 'resets 3pm' as the next 15:00 local time", () => {
    const d = worker.parseLimitReset("5-hour limit reached ∙ resets 3pm", now)!;
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([22, 15, 0]);
    const tomorrow = worker.parseLimitReset("You've hit your limit · resets at 9:30 AM (Asia/Kolkata)", now)!;
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([23, 9, 30]);
  });
  it("parses relative resets", () => {
    expect(worker.parseLimitReset("limit reached, resets in 2h 15m", now)?.getTime()).toBe(now.getTime() + 135 * 60_000);
  });
  it("returns null when no time is given", () => {
    expect(worker.parseLimitReset("usage limit reached", now)).toBeNull();
  });
  it("interpretOutput: usage limit ≠ transient rate limit ≠ logout", () => {
    const res = (text: string) => worker.interpretOutput({ result: { type: "result", is_error: true, result: text }, stderr: "", code: 1 }, 1000);
    expect(res("Claude AI usage limit reached|1764000000")).toMatchObject({ kind: "usage_limit", retryAt: new Date(1764000000 * 1000).toISOString() });
    expect(res("API Error: 529 overloaded")).toMatchObject({ kind: "limit" });
    expect(res("Not logged in · Please run /login")).toMatchObject({ kind: "auth" });
  });
});
