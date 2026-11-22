import "server-only";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { User } from "./db/schema";

declare module "next-auth" {
  interface Session {
    user: { id: string; email: string; name?: string | null; role: "ADMIN" | "USER"; mustChangePassword: boolean };
  }
  interface User {
    role: "ADMIN" | "USER";
    mustChangePassword: boolean;
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: "ADMIN" | "USER";
    mustChangePassword?: boolean;
  }
}

/**
 * First-run bootstrap: if no ADMIN exists yet and the credentials equal
 * ADMIN_EMAIL / ADMIN_PASSWORD from the environment, create the admin
 * (flagged to change password on first login).
 */
async function bootstrapAdmin(email: string, password: string): Promise<User | null> {
  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const envPass = process.env.ADMIN_PASSWORD;
  if (!envEmail || !envPass || email !== envEmail || password !== envPass) return null;
  const existingAdmin = await db.query.users.findFirst({ where: eq(schema.users.role, "ADMIN") });
  if (existingAdmin) return null;
  const [created] = await db
    .insert(schema.users)
    .values({
      email: envEmail,
      name: "Administrator",
      passwordHash: await bcrypt.hash(envPass, 12),
      role: "ADMIN",
      mustChangePassword: true,
    })
    .onConflictDoNothing()
    .returning();
  return created ?? null;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase() ?? "";
        const password = credentials?.password ?? "";
        if (!email || !password) return null;
        let user: User | null | undefined = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
        if (!user) user = await bootstrapAdmin(email, password);
        else if (!(await bcrypt.compare(password, user.passwordHash))) return null;
        if (!user || !user.active) return null;
        await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
        return { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.uid = user.id;
        token.role = user.role;
        token.mustChangePassword = user.mustChangePassword;
      } else if (trigger === "update" && token.uid) {
        const fresh = await db.query.users.findFirst({ where: eq(schema.users.id, token.uid) });
        if (fresh) {
          token.role = fresh.role;
          token.mustChangePassword = fresh.mustChangePassword;
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        id: token.uid ?? "",
        email: token.email ?? "",
        name: token.name,
        role: token.role ?? "USER",
        mustChangePassword: token.mustChangePassword ?? false,
      };
      return session;
    },
  },
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Server-side guard used by every API route and server page. Re-reads the user
 * from the DB so deactivation and role changes take effect immediately.
 */
export async function requireUser(opts: { admin?: boolean; allowPasswordChange?: boolean } = {}): Promise<User> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new HttpError(401, "Not authenticated");
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.user.id) });
  if (!user || !user.active) throw new HttpError(401, "Account inactive");
  if (user.mustChangePassword && !opts.allowPasswordChange) throw new HttpError(403, "Password change required");
  if (opts.admin && user.role !== "ADMIN") throw new HttpError(403, "Admin only");
  return user;
}

export const requireAdmin = () => requireUser({ admin: true });
