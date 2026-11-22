import { z } from "zod";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { budgetStatus, getSettings, updateSettings } from "@/lib/settings";

export const GET = handle(async () => {
  await requireAdmin();
  const s = await getSettings();
  return json({
    defaultMargin: s.defaultMargin,
    monthlyBudget: s.monthlyBudget,
    budgetCurrency: s.budgetCurrency,
    usdToInr: s.usdToInr,
    maxConversionsPerHour: s.maxConversionsPerHour,
    budget: await budgetStatus(s),
  });
});

const Body = z.object({
  defaultMargin: z.number().min(0).max(5).optional(),
  monthlyBudget: z.number().min(0).nullable().optional(),
  budgetCurrency: z.enum(["USD", "INR"]).optional(),
  usdToInr: z.number().positive().max(1000).optional(),
  maxConversionsPerHour: z.number().int().min(1).max(1000).optional(),
});

export const PUT = handle(async (req: Request) => {
  await requireAdmin();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Invalid settings");
  await updateSettings(parsed.data);
  return json({ ok: true });
});
