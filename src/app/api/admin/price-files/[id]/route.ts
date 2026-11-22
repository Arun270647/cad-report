import { eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";

/** Activate a version (exactly one active at a time; older versions are kept). */
export const PATCH = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const pf = await db.query.priceFiles.findFirst({ where: eq(schema.priceFiles.id, id), columns: { id: true } });
  if (!pf) throw new HttpError(404, "Not found");
  await db.transaction(async (tx) => {
    await tx.update(schema.priceFiles).set({ active: false }).where(ne(schema.priceFiles.id, id));
    await tx.update(schema.priceFiles).set({ active: true }).where(eq(schema.priceFiles.id, id));
  });
  return json({ ok: true });
});

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const pf = await db.query.priceFiles.findFirst({ where: eq(schema.priceFiles.id, id) });
  if (!pf) throw new HttpError(404, "Not found");
  return new Response(new Uint8Array(pf.data), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="v${pf.version}_${pf.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`,
    },
  });
});
