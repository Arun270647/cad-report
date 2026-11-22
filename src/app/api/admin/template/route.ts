import { desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json, readUpload } from "@/lib/api";
import ExcelJS from "exceljs";

export const GET = handle(async () => {
  await requireAdmin();
  const list = await db
    .select({ id: schema.templates.id, filename: schema.templates.filename, active: schema.templates.active, createdAt: schema.templates.createdAt })
    .from(schema.templates)
    .orderBy(desc(schema.templates.createdAt));
  return json({ templates: list });
});

export const POST = handle(async (req: Request) => {
  await requireAdmin();
  const { name, buf } = await readUpload(req, "xlsx");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(422, "Could not read the template workbook");
  }
  const ws = wb.worksheets[0];
  const hdr = ws ? String(ws.getRow(1).getCell(4).value ?? "").toUpperCase() : "";
  if (!hdr.includes("DESCRIPTION")) throw new HttpError(422, "Template row 1 must contain the A–N headers (column D = DESCRIPTION)");
  const created = await db.transaction(async (tx) => {
    await tx.update(schema.templates).set({ active: false }).where(eq(schema.templates.active, true));
    const [t] = await tx.insert(schema.templates).values({ filename: name, data: buf, active: true }).returning({ id: schema.templates.id });
    return t;
  });
  return json(created, 201);
});

export const PATCH = handle(async (req: Request) => {
  await requireAdmin();
  const { id } = (await req.json()) as { id?: string };
  if (!id) throw new HttpError(400, "id required");
  await db.transaction(async (tx) => {
    await tx.update(schema.templates).set({ active: false }).where(ne(schema.templates.id, id));
    await tx.update(schema.templates).set({ active: true }).where(eq(schema.templates.id, id));
  });
  return json({ ok: true });
});
