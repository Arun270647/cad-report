import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { jobLines, loadJobFor, toBomLine } from "@/lib/jobs";
import { publicJob } from "@/lib/job-view";
import { validateBom } from "@/lib/bom/validation";
import { groupByMake } from "@/lib/bom/grouping";
import type { BomLine, DeviceCounts, LineStatus } from "@/lib/bom/types";

type Ctx = { params: Promise<{ id: string }> };

async function view(jobId: string, user: Awaited<ReturnType<typeof requireUser>>) {
  const job = await loadJobFor(user, jobId);
  const lines = (await jobLines(job.id)).map(toBomLine);
  const validation = validateBom(lines, job.counts as Partial<DeviceCounts>);
  const pf = job.priceFileId
    ? await db.query.priceFiles.findFirst({ where: eq(schema.priceFiles.id, job.priceFileId), columns: { version: true, filename: true } })
    : null;
  return { job: publicJob(job), lines, grouped: groupByMake(lines), validation, priceFile: pf ?? null };
}

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  return json(await view((await ctx.params).id, user));
});

const num = z.number().finite().nullable();
const LineIn = z.object({
  id: z.number().int().optional(),
  position: z.number().int(),
  terexPn: z.string().max(100).nullable(),
  whereUsed: z.string().max(1000).nullable(),
  drgSheetNo: z.string().max(300).nullable(),
  description: z.string().max(1000).nullable(),
  mpn: z.string().max(100).nullable(),
  make: z.string().max(100).nullable(),
  uom: z.string().max(20).nullable(),
  qty: z.number().finite().min(0),
  listPrice: num,
  disc: num,
  margin: z.number().finite(),
  notes: z.string().max(2000).nullable(),
  resolveConflict: z.boolean().optional(),
});
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), lines: z.array(LineIn).max(2000) }),
  z.object({ action: z.literal("approve"), acknowledgeQuantityMismatch: z.boolean().optional() }),
]);

const clean = (s: string | null) => (s && s.trim() !== "" ? s.trim() : null);

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const job = await loadJobFor(user, (await ctx.params).id);
  if (job.userId !== user.id && user.role !== "ADMIN") throw new HttpError(403, "Forbidden");
  if (!["review", "approved"].includes(job.status)) throw new HttpError(409, "Job is not ready for review");
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Invalid data: " + parsed.error.issues[0]?.message);
  const body = parsed.data;

  if (body.action === "save") {
    const existing = new Map((await jobLines(job.id)).map((l) => [l.id, l]));
    const rows = body.lines.map((l, i) => {
      const prev = l.id ? existing.get(l.id) : undefined;
      let flags = new Set<string>(prev?.flags ?? ["manual"]);
      if (l.resolveConflict) flags.delete("conflict");
      if (l.listPrice != null) flags.delete("not_found");
      if (l.listPrice == null && prev && prev.listPrice != null) flags.add("not_found");
      const status: LineStatus = flags.has("conflict")
        ? "conflict"
        : l.listPrice == null
          ? "not_found"
          : flags.has("anomaly")
            ? "anomaly"
            : flags.has("manual")
              ? "manual"
              : "matched";
      if (l.listPrice == null) flags.add("not_found");
      flags = new Set([...flags]);
      return {
        jobId: job.id,
        position: i + 1,
        terexPn: clean(l.terexPn),
        whereUsed: clean(l.whereUsed),
        drgSheetNo: clean(l.drgSheetNo),
        description: clean(l.description),
        mpn: clean(l.mpn),
        make: clean(l.make)?.toUpperCase() ?? null,
        uom: clean(l.uom),
        qty: l.qty,
        listPrice: l.listPrice,
        disc: l.disc,
        margin: l.margin,
        notes: clean(l.notes),
        status,
        flags: [...flags],
        alternatives: status === "conflict" ? prev?.alternatives ?? [] : prev?.alternatives ?? [],
        sourceKey: prev?.sourceKey ?? null,
        sourceCount: prev?.sourceCount ?? null,
      };
    });
    await db.transaction(async (tx) => {
      await tx.delete(schema.jobLines).where(eq(schema.jobLines.jobId, job.id));
      if (rows.length) await tx.insert(schema.jobLines).values(rows);
      await tx.update(schema.jobs).set({ status: "review", approvedAt: null, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
    });
    return json(await view(job.id, user));
  }

  // approve
  const lines: BomLine[] = (await jobLines(job.id)).map(toBomLine);
  const v = validateBom(lines, job.counts as Partial<DeviceCounts>, { acknowledgeQuantityMismatch: body.acknowledgeQuantityMismatch });
  if (!v.ok) return json({ error: "Validation failed", validation: v }, 422);
  await db.update(schema.jobs).set({ status: "approved", approvedAt: new Date(), updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
  return json(await view(job.id, user));
});
