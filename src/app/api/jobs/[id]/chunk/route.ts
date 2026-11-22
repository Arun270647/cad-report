import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { CHUNK_BYTES, handle, isPdf, json } from "@/lib/api";
import { loadJobFor } from "@/lib/jobs";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const job = await loadJobFor(user, (await ctx.params).id);
  if (job.userId !== user.id) throw new HttpError(403, "Not your job");
  if (job.status !== "uploading") throw new HttpError(409, "Upload already completed");
  const idx = Number(new URL(req.url).searchParams.get("idx"));
  if (!Number.isInteger(idx) || idx < 0 || idx >= job.chunkCount) throw new HttpError(400, "Bad chunk index");
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > CHUNK_BYTES + 1024) throw new HttpError(413, "Chunk too large");
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > CHUNK_BYTES) throw new HttpError(413, "Chunk too large");
  if (idx === 0 && !isPdf(buf)) throw new HttpError(415, "File is not a PDF");
  await db.delete(schema.jobChunks).where(and(eq(schema.jobChunks.jobId, job.id), eq(schema.jobChunks.idx, idx)));
  await db.insert(schema.jobChunks).values({ jobId: job.id, idx, data: buf });
  return json({ ok: true });
});
