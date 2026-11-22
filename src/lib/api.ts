import "server-only";
import { NextResponse } from "next/server";
import { HttpError } from "./auth";
import { redactSecrets } from "./crypto";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** Wrap a route handler: maps HttpError to status codes, hides internals of other errors. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[api] unhandled error:", redactSecrets(msg));
      return json({ error: "Internal server error" }, 500);
    }
  };
}

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB total drawing size
export const MAX_XLSX_BYTES = 4 * 1024 * 1024; // single request body limit on Vercel is 4.5 MB
export const CHUNK_BYTES = 3 * 1024 * 1024;

export function isPdf(buf: Buffer) {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}
export function isXlsx(buf: Buffer) {
  // XLSX is a ZIP container: "PK\x03\x04"
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** Read a single uploaded file from multipart form data with type and size checks. */
export async function readUpload(req: Request, kind: "xlsx", field = "file"): Promise<{ name: string; buf: Buffer }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_XLSX_BYTES + 64 * 1024) throw new HttpError(413, "File too large (max 4 MB)");
  const form = await req.formData();
  const file = form.get(field);
  if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new HttpError(415, "Only .xlsx files are accepted");
  if (file.size > MAX_XLSX_BYTES) throw new HttpError(413, "File too large (max 4 MB)");
  const buf = Buffer.from(await file.arrayBuffer());
  if (kind === "xlsx" && !isXlsx(buf)) throw new HttpError(415, "File is not a valid .xlsx workbook");
  return { name: file.name.slice(0, 200), buf };
}
