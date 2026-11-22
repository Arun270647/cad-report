import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { normDeviceType } from "@/lib/bom/normalize";
import { RuleBody } from "@/lib/admin-helpers";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  await requireAdmin();
  const id = Number((await ctx.params).id);
  const parsed = RuleBody.safeParse(await req.json());
  if (!parsed.success || !Number.isInteger(id)) throw new HttpError(400, "Invalid rule");
  const d = parsed.data;
  await db
    .update(schema.matchingRules)
    .set({ deviceType: normDeviceType(d.deviceType), rating: d.rating || "-", qualifier: d.qualifier || null, mpn: d.mpn, notes: d.notes || null })
    .where(eq(schema.matchingRules.id, id));
  return json({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await requireAdmin();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid id");
  await db.delete(schema.matchingRules).where(eq(schema.matchingRules.id, id));
  return json({ ok: true });
});
