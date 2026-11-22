import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";

export const SESSION_COOKIE = "pbp_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Parse ALLOWED_EMAILS: comma-separated, trimmed, lowercased, empties dropped. */
export function allowedEmails(raw: string | undefined = process.env.ALLOWED_EMAILS): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string equality (compares SHA-256 digests, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

/** Constant-time allow-list check: every entry is compared, no early exit. */
export function isAllowed(email: string, list: string[] = allowedEmails()): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  let found = false;
  for (const entry of list) {
    if (safeEqual(e, entry)) found = true;
  }
  return found;
}

export function sessionSecret(raw: string | undefined = process.env.SESSION_SECRET): string | null {
  return raw && raw.length >= MIN_SECRET_LENGTH ? raw : null;
}

/** True when login can work at all (secret long enough and a non-empty allow-list). */
export function authConfigured(): boolean {
  return sessionSecret() !== null && allowedEmails().length > 0;
}

function hmac(secret: string, email: string, expiryMs: string): Buffer {
  return createHmac("sha256", secret).update(`${email}.${expiryMs}`, "utf8").digest();
}

/** Create a cookie value: b64url(email).b64url(expiryMs).b64url(HMAC-SHA256(secret, email + "." + expiryMs)). */
export function signSession(email: string, secret: string, nowMs = Date.now(), maxAgeS = SESSION_MAX_AGE_S): string {
  const e = normalizeEmail(email);
  const exp = String(nowMs + maxAgeS * 1000);
  return `${b64u(e)}.${b64u(exp)}.${b64u(hmac(secret, e, exp))}`;
}

/**
 * Verify a cookie value. Returns the email when the signature is valid, the session has not expired
 * and the email is still in the allow-list; otherwise null.
 */
export function verifySession(token: string | null | undefined, secret: string, list: string[], nowMs = Date.now()): string | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [pe, px, ps] = parts as [string, string, string];
  let email: string;
  let exp: string;
  let sig: Buffer;
  try {
    email = Buffer.from(pe, "base64url").toString("utf8");
    exp = Buffer.from(px, "base64url").toString("utf8");
    sig = Buffer.from(ps, "base64url");
  } catch {
    return null;
  }
  if (!/^\d{1,15}$/.test(exp)) return null;
  const expected = hmac(secret, email, exp);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  if (Number(exp) <= nowMs) return null;
  if (!isAllowed(email, list)) return null;
  return email;
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/** Return the session email or throw a 401 HttpError (503 when auth is not configured). */
export function requireSession(req: Request): string {
  const secret = sessionSecret();
  const list = allowedEmails();
  if (!secret || list.length === 0) throw new HttpError(503, "not_configured", "Sign-in is not configured on the server");
  const email = verifySession(readCookie(req.headers.get("cookie"), SESSION_COOKIE), secret, list);
  if (!email) throw new HttpError(401, "unauthorized", "Not signed in");
  return email;
}

/** ADMIN_EMAILS: comma-separated subset of ALLOWED_EMAILS who may open /admin (worker status, pause/resume). */
export function adminEmails(raw: string | undefined = process.env.ADMIN_EMAILS): string[] {
  return allowedEmails(raw);
}

export function isAdmin(email: string, list: string[] = adminEmails()): boolean {
  return list.length > 0 && isAllowed(email, list);
}

/** Session email of an admin, or throw 401 (not signed in) / 403 (signed in but not an admin). */
export function requireAdmin(req: Request): string {
  const email = requireSession(req);
  if (!isAdmin(email)) throw new HttpError(403, "forbidden", "Admins only");
  return email;
}

export function cookieOptions(maxAgeS = SESSION_MAX_AGE_S) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeS,
  };
}
