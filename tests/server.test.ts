import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const session = await import("@/lib/server/session");
const workerAuth = await import("@/lib/server/worker-auth");
const jobs = await import("@/lib/server/jobs");
const { HttpError, redact, clientIp } = await import("@/lib/server/http");

const SECRET = "s".repeat(40);
const LIST = ["owner@example.com", "second@example.com"];

describe("session cookie", () => {
  it("round-trips a signed session", () => {
    const t = session.signSession("Owner@Example.com", SECRET, 1_000);
    expect(t.split(".")).toHaveLength(3);
    expect(session.verifySession(t, SECRET, LIST, 2_000)).toBe("owner@example.com");
  });

  it("matches the contract format", () => {
    const t = session.signSession("owner@example.com", SECRET, 0, 60);
    const [e, x] = t.split(".");
    expect(Buffer.from(e!, "base64url").toString()).toBe("owner@example.com");
    expect(Buffer.from(x!, "base64url").toString()).toBe("60000");
  });

  it("rejects tampering", () => {
    const t = session.signSession("owner@example.com", SECRET, 1_000);
    const [, x, s] = t.split(".");
    const forgedEmail = `${Buffer.from("second@example.com").toString("base64url")}.${x}.${s}`;
    expect(session.verifySession(forgedEmail, SECRET, LIST, 2_000)).toBeNull();
    const farExpiry = `${t.split(".")[0]}.${Buffer.from("99999999999999").toString("base64url")}.${s}`;
    expect(session.verifySession(farExpiry, SECRET, LIST, 2_000)).toBeNull();
    expect(session.verifySession(t.slice(0, -2) + "AA", SECRET, LIST, 2_000)).toBeNull();
    expect(session.verifySession(t, "x".repeat(40), LIST, 2_000)).toBeNull();
    expect(session.verifySession("garbage", SECRET, LIST)).toBeNull();
    expect(session.verifySession("", SECRET, LIST)).toBeNull();
    expect(session.verifySession(null, SECRET, LIST)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const t = session.signSession("owner@example.com", SECRET, 0, 60);
    expect(session.verifySession(t, SECRET, LIST, 59_999)).toBe("owner@example.com");
    expect(session.verifySession(t, SECRET, LIST, 60_000)).toBeNull();
  });

  it("rejects an email removed from the allow-list", () => {
    const t = session.signSession("second@example.com", SECRET, 1_000);
    expect(session.verifySession(t, SECRET, LIST, 2_000)).toBe("second@example.com");
    expect(session.verifySession(t, SECRET, ["owner@example.com"], 2_000)).toBeNull();
    expect(session.verifySession(t, SECRET, [], 2_000)).toBeNull();
  });

  it("requireSession reads the cookie and fails closed", () => {
    const prev = { s: process.env.SESSION_SECRET, a: process.env.ALLOWED_EMAILS };
    try {
      process.env.SESSION_SECRET = SECRET;
      process.env.ALLOWED_EMAILS = LIST.join(",");
      const t = session.signSession("owner@example.com", SECRET);
      const ok = new Request("http://x/api/jobs", { headers: { cookie: `a=b; pbp_session=${t}; c=d` } });
      expect(session.requireSession(ok)).toBe("owner@example.com");
      const none = new Request("http://x/api/jobs");
      expect(() => session.requireSession(none)).toThrowError(HttpError);
      try { session.requireSession(none); } catch (e) { expect((e as InstanceType<typeof HttpError>).status).toBe(401); }
      process.env.SESSION_SECRET = "short";
      try { session.requireSession(ok); } catch (e) { expect((e as InstanceType<typeof HttpError>).status).toBe(503); }
    } finally {
      process.env.SESSION_SECRET = prev.s;
      process.env.ALLOWED_EMAILS = prev.a;
      if (prev.s === undefined) delete process.env.SESSION_SECRET;
      if (prev.a === undefined) delete process.env.ALLOWED_EMAILS;
    }
  });
});

describe("allow-list", () => {
  it("parses ALLOWED_EMAILS", () => {
    expect(session.allowedEmails(" A@x.com , ,b@Y.com,")).toEqual(["a@x.com", "b@y.com"]);
    expect(session.allowedEmails(undefined)).toEqual([]);
    expect(session.allowedEmails("")).toEqual([]);
  });
  it("matches case- and whitespace-insensitively", () => {
    const list = session.allowedEmails("Owner@Example.com");
    expect(session.isAllowed("  OWNER@example.COM ", list)).toBe(true);
    expect(session.isAllowed("owner@example.co", list)).toBe(false);
    expect(session.isAllowed("owner@example.com.evil", list)).toBe(false);
    expect(session.isAllowed("", list)).toBe(false);
    expect(session.isAllowed("owner@example.com", [])).toBe(false);
  });
  it("safeEqual compares exactly", () => {
    expect(session.safeEqual("abc", "abc")).toBe(true);
    expect(session.safeEqual("abc", "abd")).toBe(false);
    expect(session.safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("worker bearer token", () => {
  const TOKEN = "t".repeat(40);
  const req = (h?: string) => new Request("http://x/api/worker/next", { headers: h ? { authorization: h } : {} });
  it("accepts the right token only", () => {
    expect(workerAuth.bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(workerAuth.bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(workerAuth.bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(workerAuth.bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(workerAuth.bearerMatches(null, TOKEN)).toBe(false);
  });
  it("maps to 503 / 401", () => {
    const status = (fn: () => void) => { try { fn(); return 200; } catch (e) { return (e as InstanceType<typeof HttpError>).status; } };
    expect(status(() => workerAuth.requireWorker(req(`Bearer ${TOKEN}`), undefined))).toBe(503);
    expect(status(() => workerAuth.requireWorker(req(`Bearer short`), "short"))).toBe(503);
    expect(status(() => workerAuth.requireWorker(req(), TOKEN))).toBe(401);
    expect(status(() => workerAuth.requireWorker(req("Bearer nope"), TOKEN))).toBe(401);
    expect(status(() => workerAuth.requireWorker(req(`Bearer ${TOKEN}`), TOKEN))).toBe(200);
  });
});

describe("job creation validation", () => {
  const ok = (v: unknown) => jobs.CreateJobZod.safeParse(v).success;
  it("accepts a valid request and plans rows", () => {
    const input = jobs.CreateJobZod.parse({
      filename: " drawings.pdf ",
      pages: [{ page: 2, skipReason: null }, { page: 1, skipReason: "Cover sheet" }, { page: 3, skipReason: null }],
    });
    expect(input.filename).toBe("drawings.pdf");
    const plan = jobs.planJob(input);
    expect(plan.pageCount).toBe(3);
    expect(plan.status).toBe("uploading");
    expect(plan.pages.map((p) => [p.page, p.status])).toEqual([[1, "skipped"], [2, "awaiting_upload"], [3, "awaiting_upload"]]);
  });
  it("is done immediately when every page is skipped", () => {
    const plan = jobs.planJob(jobs.CreateJobZod.parse({ filename: "a.pdf", pages: [{ page: 1, skipReason: "blank" }] }));
    expect(plan.status).toBe("done");
  });
  it("rejects bad input", () => {
    expect(ok({ filename: "", pages: [{ page: 1, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "x".repeat(201), pages: [{ page: 1, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: [] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: [{ page: 0, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: [{ page: 201, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: [{ page: 1.5, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: [{ page: 1, skipReason: null }, { page: 1, skipReason: null }] })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: Array.from({ length: 201 }, (_, i) => ({ page: i + 1, skipReason: null })) })).toBe(false);
    expect(ok({ filename: "a.pdf", pages: Array.from({ length: 200 }, (_, i) => ({ page: i + 1, skipReason: null })) })).toBe(true);
  });
});

describe("page upload and job status helpers", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]).toString("base64");
  it("checks magic bytes against the declared type", () => {
    expect(jobs.decodeImage("image/png", png)).not.toBeNull();
    expect(jobs.decodeImage("image/jpeg", jpg)).not.toBeNull();
    expect(jobs.decodeImage("image/png", jpg)).toBeNull();
    expect(jobs.decodeImage("image/jpeg", png)).toBeNull();
    expect(jobs.UploadPageZod.safeParse({ mediaType: "image/gif", data: png }).success).toBe(false);
    expect(jobs.UploadPageZod.safeParse({ mediaType: "image/png", data: "data:image/png;base64," + png }).success).toBe(false);
  });
  it("derives job status per the contract", () => {
    const c = (o: Partial<Parameters<typeof jobs.deriveJobStatus>[0]>) =>
      jobs.deriveJobStatus({ skipped: 0, awaiting_upload: 0, pending: 0, processing: 0, done: 0, error: 0, started: 0, ...o });
    expect(c({ awaiting_upload: 1, pending: 1 })).toBe("uploading");
    expect(c({ pending: 2, skipped: 1 })).toBe("queued");
    expect(c({ pending: 1, processing: 1 })).toBe("processing");
    expect(c({ pending: 1, started: 1 })).toBe("processing");
    expect(c({ done: 1, error: 1, skipped: 3 })).toBe("done");
    expect(c({ skipped: 2 })).toBe("done");
  });
  it("retries only retryable failures under the attempt cap", () => {
    expect(jobs.failureOutcome(true, 1)).toBe("pending");
    expect(jobs.failureOutcome(true, 3)).toBe("error");
    expect(jobs.failureOutcome(false, 1)).toBe("error");
  });
});

describe("http helpers", () => {
  it("redacts secrets and emails from log lines", () => {
    const out = redact("fail for bob@example.com Bearer abc123 postgres://u:p@h/db");
    expect(out).not.toContain("bob@example.com");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("u:p@h");
  });
  it("finds the client IP", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "5.6.7.8" } }))).toBe("5.6.7.8");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
