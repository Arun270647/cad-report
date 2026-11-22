import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { jobLines, loadJobFor, toBomLine } from "@/lib/jobs";
import { buildWorkbook } from "@/lib/bom/excel";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const job = await loadJobFor(user, (await ctx.params).id);
  if (job.status !== "approved") throw new HttpError(409, "Approve the BOM on the review screen before exporting");
  const lines = (await jobLines(job.id)).map(toBomLine);
  const tpl = await db.query.templates.findFirst({ where: eq(schema.templates.active, true) });
  const { buffer } = await buildWorkbook(lines, { template: tpl?.data ?? null, title: job.filename });
  const name = job.filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_") + "_BOM.xlsx";
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
});
