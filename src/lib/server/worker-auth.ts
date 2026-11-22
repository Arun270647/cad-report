import "server-only";
import { HttpError } from "./http";
import { safeEqual } from "./session";

export const MIN_TOKEN_LENGTH = 32;

/** Constant-time check of an Authorization header against the worker token. */
export function bearerMatches(header: string | null, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return safeEqual(m[1] as string, token);
}

/** Throws 503 when WORKER_TOKEN is missing or shorter than 32 chars, 401 when the bearer token is wrong. */
export function requireWorker(req: Request, token: string | undefined = process.env.WORKER_TOKEN): void {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new HttpError(503, "not_configured", "Worker token is not configured on the server");
  }
  if (!bearerMatches(req.headers.get("authorization"), token)) throw new HttpError(401, "unauthorized", "Invalid worker token");
}
