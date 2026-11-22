import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { budgetStatus, getSettings } from "@/lib/settings";

const RANGES = { "24h": { ms: 864e5, bucket: "hour" }, "7d": { ms: 7 * 864e5, bucket: "day" }, "30d": { ms: 30 * 864e5, bucket: "day" } } as const;

export const GET = handle(async (req: Request) => {
  await requireAdmin();
  const rangeKey = (new URL(req.url).searchParams.get("range") ?? "24h") as keyof typeof RANGES;
  const range = RANGES[rangeKey] ?? RANGES["24h"];
  const since = new Date(Date.now() - range.ms);
  const c = schema.apiCalls;
  const bucket = sql<string>`to_char(date_trunc(${range.bucket}, ${c.createdAt}), 'YYYY-MM-DD"T"HH24:00')`;
  const series = await db
    .select({
      bucket,
      requests: sql<number>`count(*)::int`,
      success: sql<number>`sum(case when ${c.success} then 1 else 0 end)::int`,
      errors: sql<number>`sum(case when ${c.success} then 0 else 1 end)::int`,
      avgLatency: sql<number>`coalesce(avg(${c.latencyMs}),0)::int`,
      tokensIn: sql<number>`coalesce(sum(${c.inputTokens}),0)::bigint`,
      tokensOut: sql<number>`coalesce(sum(${c.outputTokens}),0)::bigint`,
      cost: sql<number>`coalesce(sum(${c.costUsd}),0)::float`,
    })
    .from(c)
    .where(gte(c.createdAt, since))
    .groupBy(bucket)
    .orderBy(bucket);

  const errors = await db
    .select({
      id: c.id,
      createdAt: c.createdAt,
      email: schema.users.email,
      jobId: c.jobId,
      kind: c.kind,
      errorType: c.errorType,
      statusCode: c.statusCode,
      message: c.message,
    })
    .from(c)
    .leftJoin(schema.users, eq(schema.users.id, c.userId))
    .where(and(eq(c.success, false), gte(c.createdAt, since)))
    .orderBy(desc(c.createdAt))
    .limit(200);

  // Live status: last scheduled health check + error rate of real calls in the last hour.
  const s = await getSettings();
  const lastCheck = await db.query.apiCalls.findFirst({
    where: sql`${c.kind} in ('health','test')`,
    orderBy: desc(c.createdAt),
  });
  const hourAgo = new Date(Date.now() - 36e5);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int`, errs: sql<number>`sum(case when ${c.success} then 0 else 1 end)::int`, lat: sql<number>`coalesce(avg(${c.latencyMs}),0)::int` })
    .from(c)
    .where(gte(c.createdAt, hourAgo));
  const errRate = recent?.n ? (recent.errs ?? 0) / recent.n : 0;
  let status: "Connected" | "Degraded" | "Down" | "Not configured" = "Connected";
  let reason = "Last health check succeeded";
  if (!s.apiKeyCiphertext) {
    status = "Not configured";
    reason = "No API key stored";
  } else if (!lastCheck) {
    status = "Degraded";
    reason = "No health check has run yet";
  } else if (!lastCheck.success) {
    status = "Down";
    reason = `Last health check failed (${lastCheck.errorType ?? "error"})`;
  } else if (errRate >= 0.2 && (recent?.n ?? 0) >= 3) {
    status = "Degraded";
    reason = `${Math.round(errRate * 100)}% of calls failed in the last hour`;
  } else if (lastCheck.latencyMs > 15000) {
    status = "Degraded";
    reason = `Slow responses (${lastCheck.latencyMs} ms)`;
  }
  const totals = series.reduce(
    (t, r) => ({
      requests: t.requests + r.requests,
      errors: t.errors + r.errors,
      cost: t.cost + Number(r.cost),
      tokensIn: t.tokensIn + Number(r.tokensIn),
      tokensOut: t.tokensOut + Number(r.tokensOut),
    }),
    { requests: 0, errors: 0, cost: 0, tokensIn: 0, tokensOut: 0 },
  );
  return json({
    status,
    reason,
    lastCheck: lastCheck ? { at: lastCheck.createdAt, success: lastCheck.success, latencyMs: lastCheck.latencyMs, model: lastCheck.model } : null,
    lastHour: { requests: recent?.n ?? 0, errorRate: errRate, avgLatency: recent?.lat ?? 0 },
    series: series.map((r) => ({ ...r, tokensIn: Number(r.tokensIn), tokensOut: Number(r.tokensOut), cost: Number(r.cost) })),
    totals,
    errors,
    budget: await budgetStatus(s),
    conversionsEnabled: s.conversionsEnabled,
  });
});
