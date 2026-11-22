import { z } from "zod";
import { sql } from "@/lib/server/db";
import { handle, json, parseWith, readJson } from "@/lib/server/http";
import { MAX_REFERENCE_BYTES, sha256, validateReference } from "@/lib/server/reference";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UploadZod = z.object({
  kind: z.enum(["price_list", "template"]),
  filename: z.string().trim().min(1).max(200).regex(/\.xlsx$/i, "must be an .xlsx file"),
  data: z.string().min(16).max(Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, "data must be plain base64"),
});

const SettingsZod = z.object({ margin: z.number().min(0).max(1) });

/**
 * POST (admin) {kind, filename, data: base64} → replace the active price list / template (validated first).
 * POST (admin) {margin: 0..1} → set the report margin.
 */
export const POST = handle(async (req: Request) => {
  const email = requireAdmin(req);
  const body = await readJson(req, Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 2000);
  const db = sql();
  if (body && typeof body === "object" && "margin" in body) {
    const { margin } = parseWith(SettingsZod, body);
    await db`UPDATE bom.settings SET margin = ${margin} WHERE id = 1`;
    return json({ ok: true, margin });
  }
  const up = parseWith(UploadZod, body);
  const buf = new Uint8Array(Buffer.from(up.data, "base64"));
  const summary = await validateReference(up.kind, buf);
  const hash = sha256(buf);
  await db`
    INSERT INTO bom.reference_files (kind, filename, content, sha256, size, uploaded_by, uploaded_at)
    VALUES (${up.kind}, ${up.filename}, ${Buffer.from(buf)}, ${hash}, ${buf.length}, ${email}, now())
    ON CONFLICT (kind) DO UPDATE SET filename = EXCLUDED.filename, content = EXCLUDED.content, sha256 = EXCLUDED.sha256,
      size = EXCLUDED.size, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at`;
  return json({ ok: true, kind: up.kind, sha256: hash, summary });
});
