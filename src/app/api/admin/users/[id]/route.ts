import bcrypt from "bcryptjs";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { tempPassword } from "@/lib/admin-helpers";

const Body = z.object({ action: z.enum(["deactivate", "activate", "reset", "makeAdmin", "makeUser"]) });

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Invalid action");
  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!target) throw new HttpError(404, "User not found");
  const { action } = parsed.data;
  if (target.id === admin.id && action !== "reset") throw new HttpError(400, "You cannot change your own role or status");
  if ((action === "deactivate" || action === "makeUser") && target.role === "ADMIN") {
    const others = await db.query.users.findFirst({
      where: and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true), ne(schema.users.id, target.id)),
    });
    if (!others) throw new HttpError(400, "At least one active admin is required");
  }
  if (action === "reset") {
    const pw = tempPassword();
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: true }).where(eq(schema.users.id, id));
    return json({ ok: true, temporaryPassword: pw });
  }
  const patch =
    action === "deactivate" ? { active: false } : action === "activate" ? { active: true } : action === "makeAdmin" ? { role: "ADMIN" as const } : { role: "USER" as const };
  await db.update(schema.users).set(patch).where(eq(schema.users.id, id));
  return json({ ok: true });
});
