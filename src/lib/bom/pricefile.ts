import ExcelJS from "exceljs";
import type { PriceRow } from "./types";
import { clean, normMpn } from "./normalize";

const COLS: Record<keyof Omit<PriceRow, "id" | "rowNumber" | "mpnNorm">, string[]> = {
  terexPn: ["TEREXPN", "TEREXP/N", "TEREXPARTNO"],
  whereUsed: ["WHEREUSED"],
  drgSheetNo: ["DRGSHEETNO", "DRGSHEET", "SHEETNO"],
  description: ["DESCRIPTION"],
  mpn: ["MANUFACTUREPN", "MANUFACTURERPN", "MANUFACTUREP/N", "MANUFACTURERP/N", "MFRPN", "MPN"],
  make: ["MAKE", "BRAND"],
  uom: ["UOM"],
  qty: ["QTY", "QUANTITY"],
  listPrice: ["LISTPRICE"],
  disc: ["DISC", "DISCOUNT"],
  unitPrice: ["UNITPRICE"],
  margin: ["MARGIN"],
  terexUnitPrice: ["TEREXUNITPRICE"],
  totalPrice: ["TOTALPRICE"],
  tagNo: ["TAGNO", "TAG"],
};

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9/]/g, "").replace(/\//g, "");

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (typeof v === "object") {
    if ("result" in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if (v instanceof Date) return v.toISOString();
    if ("error" in v) return null;
  }
  return v;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,₹$\s]/g, "");
  const pct = s.endsWith("%");
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

function frac(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return n > 1 ? n / 100 : n; // "35" -> 0.35
}

/** Parse a consolidated price file. Finds the header row within the first 15 rows by column names. */
export async function parsePriceFile(buf: Buffer): Promise<{ rows: PriceRow[]; sheet: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    let headerRow = 0;
    const colMap: Partial<Record<keyof typeof COLS, number>> = {};
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const found: Partial<Record<keyof typeof COLS, number>> = {};
      row.eachCell((cell, col) => {
        const k = key(String(cellValue(cell.value) ?? ""));
        for (const [field, names] of Object.entries(COLS) as [keyof typeof COLS, string[]][]) {
          if (found[field] == null && names.map(key).includes(k)) found[field] = col;
        }
      });
      if (found.description != null && (found.mpn != null || found.listPrice != null)) {
        headerRow = r;
        Object.assign(colMap, found);
        break;
      }
    }
    if (!headerRow) continue;
    const rows: PriceRow[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (f: keyof typeof COLS) => (colMap[f] ? cellValue(row.getCell(colMap[f]!).value) : null);
      const description = clean(get("description"));
      const mpn = clean(get("mpn"));
      if (!description && !mpn) continue;
      rows.push({
        rowNumber: r,
        terexPn: clean(get("terexPn")),
        whereUsed: clean(get("whereUsed")),
        drgSheetNo: clean(get("drgSheetNo")),
        description,
        mpn,
        mpnNorm: normMpn(mpn),
        make: clean(get("make"))?.toUpperCase() ?? null,
        uom: clean(get("uom")),
        qty: num(get("qty")),
        listPrice: num(get("listPrice")),
        disc: frac(get("disc")),
        unitPrice: num(get("unitPrice")),
        margin: frac(get("margin")),
        terexUnitPrice: num(get("terexUnitPrice")),
        totalPrice: num(get("totalPrice")),
        tagNo: clean(get("tagNo")),
      });
    }
    return { rows, sheet: ws.name };
  }
  throw new Error("Could not find a header row with DESCRIPTION and MANUFACTURE P/N / LIST PRICE columns");
}

export interface PriceIssue {
  mpn: string;
  kind: "conflict" | "duplicate";
  rows: { rowNumber: number; terexPn: string | null; description: string | null; make: string | null; listPrice: number | null; disc: number | null; unitPrice: number | null }[];
}

/** Same manufacturer P/N with different prices = conflict; identical prices = duplicate. */
export function findPriceIssues(rows: PriceRow[]): PriceIssue[] {
  const byMpn = new Map<string, PriceRow[]>();
  for (const r of rows) if (r.mpnNorm) byMpn.set(r.mpnNorm, [...(byMpn.get(r.mpnNorm) ?? []), r]);
  const issues: PriceIssue[] = [];
  for (const list of byMpn.values()) {
    if (list.length < 2) continue;
    const effective = (r: PriceRow) => (r.listPrice != null ? r.listPrice * (1 - (r.disc ?? 0)) : r.unitPrice);
    const prices = new Set(list.map((r) => (effective(r) ?? NaN).toFixed(4)));
    issues.push({
      mpn: list[0].mpn ?? list[0].mpnNorm!,
      kind: prices.size > 1 ? "conflict" : "duplicate",
      rows: list.map((r) => ({
        rowNumber: r.rowNumber,
        terexPn: r.terexPn,
        description: r.description,
        make: r.make,
        listPrice: r.listPrice,
        disc: r.disc,
        unitPrice: r.unitPrice,
      })),
    });
  }
  return issues.sort((a, b) => Number(b.kind === "conflict") - Number(a.kind === "conflict") || a.mpn.localeCompare(b.mpn));
}
