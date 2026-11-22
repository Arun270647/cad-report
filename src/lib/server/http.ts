import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

/** Error with an HTTP status and a stable machine-readable code. Its message is shown to the client. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const NO_STORE = "no-store";

/** JSON response that is never cached. */
export function json(body: unknown, status = 200, init?: { headers?: Record<string, string> }): NextResponse {
  const res = NextResponse.json(body, { status, headers: init?.headers });
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

/** Empty response (e.g. 204) that is never cached. */
export function empty(status = 204): NextResponse {
  return new NextResponse(null, { status, headers: { "Cache-Control": NO_STORE } });
}

export function errorResponse(err: HttpError): NextResponse {
  return json({ error: err.message, code: err.code }, err.status);
}

/** Short, non-reversible tag for an email so logs can correlate without storing the address. */
export function emailTag(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 10);
}

/** Remove things that must never reach logs: emails, bearer tokens, connection strings, long base64 blobs. */
export function redact(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgres://***")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `<email:${emailTag(m)}>`)
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "<blob>")
    .slice(0, 500);
}

/**
 * Wrap a route handler: maps HttpError to its JSON response, everything else to a generic 500,
 * and logs only a redacted one-line message.
 */
export function handle<C>(fn: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response> {
  return async (req: Request, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500) console.error(`[api] ${req.method} ${new URL(req.url).pathname} -> ${e.status} ${e.code}`);
        return errorResponse(e);
      }
      const name = e instanceof Error ? e.name : "Error";
      const msg = e instanceof Error ? e.message : String(e);
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} -> 500 ${name}${code ? ` (${code})` : ""}: ${redact(msg)}`);
      return errorResponse(new HttpError(500, "internal", "Internal server error"));
    }
  };
}

/** Best-effort client IP (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  const ip = first || req.headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}

/** Read and parse a JSON body with a size cap (in characters). */
export async function readJson(req: Request, maxChars: number): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > maxChars * 1.1 + 1024) throw new HttpError(413, "too_large", "Request body is too large");
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, "too_large", "Request body is too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON");
  }
}

/** Validate with zod; on failure throw a 400 with a short, non-sensitive description. */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, "invalid_request", `Invalid request: ${where}${issue?.message ?? "invalid"}`.slice(0, 300));
  }
  return r.data;
}
