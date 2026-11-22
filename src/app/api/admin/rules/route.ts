import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { normDeviceType } from "@/lib/bom/normalize";
import { RuleBody } from "@/lib/admin-helpers";

export const GET = handle(async () => {
  await requireAdmin();
  return json({ rules: await db.select().from(schema.matchingRules).orderBy(asc(schema.matchingRules.deviceType), asc(schema.matchingRules.rating)) });
});


export const POST = handle(async (req: Request) => {
  await requireAdmin();
  const parsed = RuleBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Device type and manufacturer P/N are required");
  const d = parsed.data;
  const [r] = await db
    .insert(schema.matchingRules)
    .values({ deviceType: normDeviceType(d.deviceType), rating: d.rating || "-", qualifier: d.qualifier || null, mpn: d.mpn, notes: d.notes || null })
    .returning();
  return json(r, 201);
});
