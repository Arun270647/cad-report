import "server-only";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { ReferenceKind, ReferenceMeta } from "@/lib/contract";
import { buildCatalog, catalogText } from "@/lib/bom/catalog";
import { parsePriceFile } from "@/lib/bom/pricefile";
import type { Db } from "./db";
import { HttpError } from "./http";

/**
 * Preloaded reference data: the consolidated price list and the Excel template. Stored in bom.reference_files
 * (never in the public Git repo); served only to signed-in users; replaced only by admins.
 */
export const REFERENCE_KINDS: ReferenceKind[] = ["price_list", "template"];
export const MAX_REFERENCE_BYTES = 2_500_000;
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const sha256 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

interface MetaRow {
  kind: ReferenceKind;
  filename: string;
  sha256: string;
  size: number;
  uploaded_by: string | null;
  uploaded_at: Date;
}

export async function loadReferenceMeta(db: Db): Promise<Record<ReferenceKind, ReferenceMeta | null>> {
  const rows = await db<MetaRow[]>`SELECT kind, filename, sha256, size, uploaded_by, uploaded_at FROM bom.reference_files`;
  const out: Record<ReferenceKind, ReferenceMeta | null> = { price_list: null, template: null };
  for (const r of rows) {
    out[r.kind] = { filename: r.filename, sha256: r.sha256, size: r.size, uploadedBy: r.uploaded_by, uploadedAt: new Date(r.uploaded_at).toISOString() };
  }
  return out;
}

export async function loadReferenceFile(db: Db, kind: ReferenceKind): Promise<{ filename: string; content: Buffer; sha256: string } | null> {
  const [r] = await db<{ filename: string; content: Buffer; sha256: string }[]>`
    SELECT filename, content, sha256 FROM bom.reference_files WHERE kind = ${kind}`;
  return r ? { filename: r.filename, content: Buffer.from(r.content), sha256: r.sha256 } : null;
}

export async function priceListVersion(db: Db): Promise<string | null> {
  const [r] = await db<{ sha256: string }[]>`SELECT sha256 FROM bom.reference_files WHERE kind = 'price_list'`;
  return r?.sha256 ?? null;
}

/** Throws a 400 HttpError when the file is not a usable price list / template. Returns a short description. */
export async function validateReference(kind: ReferenceKind, buf: Uint8Array): Promise<string> {
  if (buf.length === 0 || buf.length > MAX_REFERENCE_BYTES) throw new HttpError(400, "invalid_file", `File must be 1 byte – ${MAX_REFERENCE_BYTES / 1_000_000} MB`);
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new HttpError(400, "invalid_file", "File is not an .xlsx workbook");
  if (kind === "price_list") {
    let parsed;
    try {
      parsed = await parsePriceFile(buf);
    } catch (e) {
      throw new HttpError(400, "invalid_file", `Price list: ${(e as Error).message}`.slice(0, 300));
    }
    const parts = buildCatalog(parsed.rows).length;
    if (parts === 0) throw new HttpError(400, "invalid_file", "Price list has no rows with a DESCRIPTION");
    return `${parsed.rows.length} rows, ${parts} distinct parts`;
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, "invalid_file", "Template could not be opened as .xlsx");
  }
  const ws = wb.worksheets[0];
  for (let r = 1; ws && r <= Math.min(10, ws.rowCount); r++) {
    if (/TEREX\s*P\s*\/?\s*N/i.test(String(ws.getRow(r).getCell(1).value ?? ""))) return `header on row ${r}`;
  }
  throw new HttpError(400, "invalid_file", "Template: no header row with TEREX P/N in column A (rows 1–10)");
}

/* ---------- catalog for the worker (memoised per price-list version) ---------- */

const g = globalThis as unknown as { __bomCatalog?: { version: string; count: number; text: string } };

export async function getCatalog(db: Db): Promise<{ version: string; count: number; text: string } | null> {
  const version = await priceListVersion(db);
  if (!version) return null;
  if (g.__bomCatalog?.version === version) return g.__bomCatalog;
  const file = await loadReferenceFile(db, "price_list");
  if (!file) return null;
  const { rows } = await parsePriceFile(file.content);
  const entries = buildCatalog(rows);
  g.__bomCatalog = { version: file.sha256, count: entries.length, text: catalogText(entries) };
  return g.__bomCatalog;
}
