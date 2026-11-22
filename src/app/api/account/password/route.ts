import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/api";

const Body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) });

export const POST = handle(async (req: Request) => {
  const user = await requireUser({ allowPasswordChange: true });
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "New password must be at least 10 characters");
  const { currentPassword, newPassword } = parsed.data;
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
  if (currentPassword === newPassword) throw new HttpError(400, "New password must be different");
  if (process.env.ADMIN_PASSWORD && newPassword === process.env.ADMIN_PASSWORD) throw new HttpError(400, "Choose a password different from the setup password");
  await db
    .update(schema.users)
    .set({ passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false })
    .where(eq(schema.users.id, user.id));
  return json({ ok: true });
});
