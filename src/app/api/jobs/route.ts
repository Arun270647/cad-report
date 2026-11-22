import { z } from "zod";
import { db, schema } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { CHUNK_BYTES, MAX_PDF_BYTES, handle, json } from "@/lib/api";
import { activePriceFile, assertCanConvert, listJobs } from "@/lib/jobs";
import { budgetStatus, conversionsLastHour, getSettings } from "@/lib/settings";
import { eq } from "drizzle-orm";

export const GET = handle(async () => {
  const user = await requireUser();
  const s = await getSettings();
  const pf = await activePriceFile();
  const tpl = await db.query.templates.findFirst({ where: eq(schema.templates.active, true), columns: { filename: true } });
  const blocked = (await budgetStatus(s)).level >= 100;
  // NOTE: only non-sensitive status is exposed to users — nothing about the API key.
  return json({
    jobs: await listJobs({ userId: user.id }),
    status: {
      conversionsEnabled: s.conversionsEnabled && !blocked && !!s.apiKeyCiphertext,
      reason: !s.conversionsEnabled ? "maintenance" : blocked ? "budget" : !s.apiKeyCiphertext ? "not_configured" : null,
      priceFile: pf ? { version: pf.version, filename: pf.filename } : null,
      template: tpl?.filename ?? null,
      margin: s.defaultMargin,
    },
  });
});

const Body = z.object({ filename: z.string().min(1).max(200), size: z.number().int().positive() });

/** Create a conversion job; the PDF is then uploaded in ≤3 MB chunks (Vercel body limit is 4.5 MB). */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Invalid request");
  const { filename, size } = parsed.data;
  if (!filename.toLowerCase().endsWith(".pdf")) throw new HttpError(415, "Only PDF drawings are accepted");
  if (size > MAX_PDF_BYTES) throw new HttpError(413, `File too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`);
  const s = await assertCanConvert();
  if ((await conversionsLastHour(user.id)) >= s.maxConversionsPerHour)
    throw new HttpError(429, `Rate limit: at most ${s.maxConversionsPerHour} conversions per hour`);
  const pf = await activePriceFile();
  if (!pf) throw new HttpError(409, "No active price file. Ask an administrator to upload one.");
  const chunkCount = Math.ceil(size / CHUNK_BYTES);
  const [job] = await db
    .insert(schema.jobs)
    .values({ userId: user.id, filename, fileSize: size, chunkCount, priceFileId: pf.id, margin: s.defaultMargin, status: "uploading" })
    .returning({ id: schema.jobs.id });
  return json({ id: job.id, chunkSize: CHUNK_BYTES, chunkCount }, 201);
});
