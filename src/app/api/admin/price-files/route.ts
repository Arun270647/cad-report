import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json, readUpload } from "@/lib/api";
import { findPriceIssues, parsePriceFile } from "@/lib/bom/pricefile";

export const GET = handle(async () => {
  await requireAdmin();
  const files = await db
    .select({
      id: schema.priceFiles.id,
      version: schema.priceFiles.version,
      filename: schema.priceFiles.filename,
      active: schema.priceFiles.active,
      rowCount: schema.priceFiles.rowCount,
      createdAt: schema.priceFiles.createdAt,
    })
    .from(schema.priceFiles)
    .orderBy(desc(schema.priceFiles.version));
  return json({ files });
});

/** Upload a new version. It is NOT activated automatically unless it is the first file. */
export const POST = handle(async (req: Request) => {
  const admin = await requireAdmin();
  const { name, buf } = await readUpload(req, "xlsx");
  let parsed;
  try {
    parsed = await parsePriceFile(buf);
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : "Could not parse the price file");
  }
  if (!parsed.rows.length) throw new HttpError(422, "The price file has no data rows");
  const [{ maxV }] = await db.select({ maxV: sql<number>`coalesce(max(${schema.priceFiles.version}),0)::int` }).from(schema.priceFiles);
  const hasActive = await db.query.priceFiles.findFirst({ where: eq(schema.priceFiles.active, true), columns: { id: true } });
  const created = await db.transaction(async (tx) => {
    const [pf] = await tx
      .insert(schema.priceFiles)
      .values({ version: maxV + 1, filename: name, uploadedBy: admin.id, rowCount: parsed.rows.length, data: buf, active: !hasActive })
      .returning({ id: schema.priceFiles.id, version: schema.priceFiles.version });
    for (let i = 0; i < parsed.rows.length; i += 500) {
      await tx.insert(schema.priceItems).values(parsed.rows.slice(i, i + 500).map((r) => ({ ...r, priceFileId: pf.id })));
    }
    return pf;
  });
  const issues = findPriceIssues(parsed.rows);
  return json({ ...created, rowCount: parsed.rows.length, conflicts: issues.filter((i) => i.kind === "conflict").length, duplicates: issues.filter((i) => i.kind === "duplicate").length }, 201);
});
