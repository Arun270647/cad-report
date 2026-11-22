import { z } from "zod";
import { sql } from "@/lib/server/db";
import { clientIp, handle, HttpError, json, parseWith, readJson } from "@/lib/server/http";
import {
  allowedEmails,
  cookieOptions,
  isAllowed,
  normalizeEmail,
  requireSession,
  SESSION_COOKIE,
  sessionSecret,
  signSession,
} from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILED = 10;
const LoginZod = z.object({ email: z.string().trim().min(3).max(320) });

/** POST {email} → 200 {email} + cookie; 401 not allowed; 429 too many failures; 503 not configured. */
export const POST = handle(async (req: Request) => {
  const secret = sessionSecret();
  const list = allowedEmails();
  if (!secret || list.length === 0) throw new HttpError(503, "not_configured", "Sign-in is not configured on the server");

  const ip = clientIp(req);
  const db = sql();
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bom.login_attempts
     WHERE ip = ${ip} AND ok = false AND at > now() - interval '15 minutes'`;
  if ((row?.n ?? 0) >= MAX_FAILED) {
    throw new HttpError(429, "rate_limited", "Too many failed sign-in attempts. Try again in 15 minutes.");
  }

  const { email } = parseWith(LoginZod, await readJson(req, 4096));
  const ok = isAllowed(email, list);
  await db`INSERT INTO bom.login_attempts (ip, ok) VALUES (${ip}, ${ok})`;
  if (Math.random() < 0.05) {
    await db`DELETE FROM bom.login_attempts WHERE at < now() - interval '1 day'`;
  }
  if (!ok) throw new HttpError(401, "not_allowed", "This email is not allowed to use this app");

  const normalized = normalizeEmail(email);
  const res = json({ email: normalized });
  res.cookies.set(SESSION_COOKIE, signSession(normalized, secret), cookieOptions());
  return res;
});

/** DELETE → clears the cookie. */
export const DELETE = handle(async () => {
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
});

/** GET → {email} or 401. */
export const GET = handle(async (req: Request) => json({ email: requireSession(req) }));
