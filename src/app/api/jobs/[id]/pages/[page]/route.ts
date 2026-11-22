import { sql } from "@/lib/server/db";
import { handle, HttpError, json, parseWith, readJson } from "@/lib/server/http";
import { decodeImage, MAX_IMAGE_B64, PageParamsZod, refreshJobStatus, UploadPageZod } from "@/lib/server/jobs";
import { requireSession } from "@/lib/server/session";
import type { PageStatus } from "@/lib/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string; page: string }> };

/** POST UploadPageRequest → 200 {ok:true}. Allowed while the page is awaiting_upload (or still pending: idempotent). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const email = requireSession(req);
  const raw = await ctx.params;
  const params = PageParamsZod.safeParse(raw);
  if (!params.success) throw new HttpError(404, "not_found", "Page not found");
  const { id, page } = params.data;

  const body = parseWith(UploadPageZod, await readJson(req, MAX_IMAGE_B64 + 1000));
  const image = decodeImage(body.mediaType, body.data);
  if (!image) throw new HttpError(400, "invalid_image", `Data is not a valid ${body.mediaType === "image/png" ? "PNG" : "JPEG"} image`);

  const db = sql();
  await db.begin(async (tx) => {
    const updated = await tx<{ page: number }[]>`
      UPDATE bom.job_pages p
         SET status = 'pending',
             image = ${image},
             media_type = ${body.mediaType},
             error = NULL,
             updated_at = CASE WHEN p.status = 'awaiting_upload' THEN now() ELSE p.updated_at END
        FROM bom.jobs j
       WHERE j.id = p.job_id AND j.email = ${email}
         AND p.job_id = ${id} AND p.page = ${page}
         AND p.status IN ('awaiting_upload', 'pending')
      RETURNING p.page`;
    if (updated.length === 0) {
      const [existing] = await tx<{ status: PageStatus }[]>`
        SELECT p.status FROM bom.job_pages p JOIN bom.jobs j ON j.id = p.job_id
         WHERE j.id = ${id} AND j.email = ${email} AND p.page = ${page}`;
      if (!existing) throw new HttpError(404, "not_found", "Page not found");
      throw new HttpError(409, "conflict", `Page is already ${existing.status}`);
    }
    await refreshJobStatus(tx, id);
  });

  return json({ ok: true });
});
