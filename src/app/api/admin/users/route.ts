import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { tempPassword } from "@/lib/admin-helpers";

export const GET = handle(async () => {
  await requireAdmin();
  const u = schema.users;
  const rows = await db
    .select({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      jobCount: sql<number>`(select count(*)::int from ${schema.jobs} j where j.user_id = ${u.id})`,
      apiCalls: sql<number>`(select count(*)::int from ${schema.apiCalls} c where c.user_id = ${u.id})`,
      apiCost: sql<number>`(select coalesce(sum(c.cost_usd),0)::float from ${schema.apiCalls} c where c.user_id = ${u.id})`,
      tokens: sql<number>`(select coalesce(sum(c.input_tokens + c.output_tokens),0)::bigint from ${schema.apiCalls} c where c.user_id = ${u.id})`,
    })
    .from(u)
    .orderBy(u.createdAt);
  return json({ users: rows.map((r) => ({ ...r, tokens: Number(r.tokens) })) });
});

const Body = z.object({ email: z.string().email().max(200), name: z.string().max(100).optional(), role: z.enum(["ADMIN", "USER"]).default("USER") });

/** Invite = create the account with a one-time temporary password (shown once to the admin). */
export const POST = handle(async (req: Request) => {
  await requireAdmin();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Valid email required");
  const email = parsed.data.email.trim().toLowerCase();
  if (await db.query.users.findFirst({ where: eq(schema.users.email, email) })) throw new HttpError(409, "A user with that email already exists");
  const pw = tempPassword();
  const [created] = await db
    .insert(schema.users)
    .values({ email, name: parsed.data.name ?? null, role: parsed.data.role, passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: true })
    .returning({ id: schema.users.id, email: schema.users.email });
  return json({ ...created, temporaryPassword: pw }, 201);
});
