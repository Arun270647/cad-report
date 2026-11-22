import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "./db";
import type { Settings } from "./db/schema";

export const MODELS: { id: string; label: string; inPerM: number; outPerM: number; fallbacks: boolean }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)", inPerM: 4, outPerM: 20, fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inPerM: 2, outPerM: 10, fallbacks: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", inPerM: 0.1, outPerM: 0.5, fallbacks: false },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", inPerM: 8, outPerM: 40, fallbacks: true },
  { id: "claude-opus-5", label: "Claude Opus 5", inPerM: 5, outPerM: 25, fallbacks: true },
];

export function modelInfo(id: string) {
  return MODELS.find((m) => m.id === id) ?? { id, label: id, inPerM: 4, outPerM: 20, fallbacks: false };
}

export async function getSettings(): Promise<Settings> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.id, 1) });
  if (row) return row;
  const [created] = await db.insert(schema.settings).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await db.query.settings.findFirst({ where: eq(schema.settings.id, 1) }))!;
}

export async function updateSettings(patch: Partial<Settings>) {
  await getSettings();
  await db
    .update(schema.settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.settings.id, 1));
}

export function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

export async function monthSpendUsd(): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.apiCalls.costUsd}), 0)` })
    .from(schema.apiCalls)
    .where(gte(schema.apiCalls.createdAt, start));
  return Number(r?.total ?? 0);
}

export interface BudgetStatus {
  spendUsd: number;
  spendInBudgetCurrency: number;
  budget: number | null;
  currency: string;
  pct: number | null;
  level: 0 | 80 | 100;
}

export async function budgetStatus(s?: Settings): Promise<BudgetStatus> {
  const settings = s ?? (await getSettings());
  const spendUsd = await monthSpendUsd();
  const conv = settings.budgetCurrency === "INR" ? settings.usdToInr : 1;
  const spend = spendUsd * conv;
  const budget = settings.monthlyBudget && settings.monthlyBudget > 0 ? settings.monthlyBudget : null;
  const pct = budget ? spend / budget : null;
  const level: 0 | 80 | 100 = pct == null ? 0 : pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
  // record alert transitions once per month (shown on the admin dashboard)
  const mk = monthKey();
  if (level > 0 && (settings.budgetAlertMonth !== mk || settings.budgetAlertLevel < level)) {
    await updateSettings({ budgetAlertMonth: mk, budgetAlertLevel: level });
    console.warn(`[budget] monthly budget alert: ${level}% reached`);
  }
  return { spendUsd, spendInBudgetCurrency: spend, budget, currency: settings.budgetCurrency, pct, level };
}

/** Conversions-per-hour limit for a user. */
export async function conversionsLastHour(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.userId, userId), gte(schema.jobs.createdAt, since)));
  return Number(r?.n ?? 0);
}
