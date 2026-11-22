import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge gate. Verifies the pbp_session cookie with Web Crypto (HMAC-SHA256) and checks the email is
 * still in ALLOWED_EMAILS. API handlers verify again server-side with Node crypto.
 * Fails closed when SESSION_SECRET (>= 32 chars) or ALLOWED_EMAILS is missing.
 */

const COOKIE = "pbp_session";
const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function allowList(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function secret(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** Constant-time-ish string compare (no early exit on content). */
function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function verify(token: string | undefined, key: string, list: string[]): Promise<string | null> {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const eb = b64urlToBytes(parts[0] as string);
  const xb = b64urlToBytes(parts[1] as string);
  const sig = b64urlToBytes(parts[2] as string);
  if (!eb || !xb || !sig) return null;
  const email = new TextDecoder().decode(eb);
  const exp = new TextDecoder().decode(xb);
  if (!/^\d{1,15}$/.test(exp)) return null;
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", k, sig as BufferSource, enc.encode(`${email}.${exp}`));
  if (!ok) return null;
  if (Number(exp) <= Date.now()) return null;
  let found = false;
  const e = email.trim().toLowerCase();
  for (const entry of list) if (sameString(e, entry)) found = true;
  return found ? email : null;
}

function isPublic(pathname: string): boolean {
  if (pathname === "/login" || pathname.startsWith("/login/")) return true;
  if (pathname === "/api/session") return true;
  if (pathname.startsWith("/api/worker/")) return true; // bearer-token auth in the handlers
  if (pathname.startsWith("/api/cron/")) return true; // CRON_SECRET bearer auth in the handlers
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  // static files from /public (e.g. pdf.js worker, icons) — never API routes
  if (!pathname.startsWith("/api/") && /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(pathname)) return true;
  return false;
}

function deny(req: NextRequest, status: 401 | 503, code: string, message: string): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = status === 503 ? "?error=not_configured" : "";
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const key = secret();
  const list = allowList();
  if (!key || list.length === 0) {
    return deny(req, 503, "not_configured", "Sign-in is not configured on the server (SESSION_SECRET / ALLOWED_EMAILS)");
  }
  const email = await verify(req.cookies.get(COOKIE)?.value, key, list);
  if (!email) return deny(req, 401, "unauthorized", "Not signed in");
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
