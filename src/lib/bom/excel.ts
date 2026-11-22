import ExcelJS from "exceljs";
import type { BomLine } from "./types";
import { groupByMake, type GroupedBom } from "./grouping";
import { displayMake } from "./normalize";

export const TEMPLATE_HEADERS = [
  "TEREX P/N",
  "WHERE USED",
  "DRG SHEET NO",
  "DESCRIPTION",
  "MANUFACTURE P/N",
  "MAKE",
  "UOM",
  "QTY",
  "LIST PRICE",
  "Disc",
  "Unit price",
  "Margin",
  "Terex Unit price",
  "Total Price",
];

const FONT: Partial<ExcelJS.Font> = { name: "Calibri", size: 10 };
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};
const YELLOW: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
const MAKE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
const SUB_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
const MONEY = "#,##0.00";
const PCT = "0.0%";

export interface ExportLayout {
  headerRow: number;
  makeHeaderRows: Record<string, number>;
  itemRows: Record<string, number[]>;
  subtotalRows: Record<string, number>;
  grandTotalRow: number;
  summaryHeaderRow: number;
  summaryRows: Record<string, number>;
}

export interface ExportResult {
  buffer: Uint8Array;
  layout: ExportLayout;
  grouped: GroupedBom;
}

function styleRow(row: ExcelJS.Row, cols = 14) {
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.font = { ...FONT, ...(cell.font?.bold ? { bold: true } : {}) };
    cell.border = THIN;
  }
}

/**
 * Build the priced BOM workbook in the template format (columns A–N) with LIVE formulas:
 *   K = I-(I*J), M = K+(K*L), N = H*M, per-make SUBTOTAL = SUM(N…), GRAND TOTAL = sum of subtotals.
 * Cached formula results are written too so the file reads correctly before recalculation.
 */
export async function buildWorkbook(
  lines: BomLine[],
  opts: { template?: ArrayBuffer | Uint8Array | null; title?: string } = {},
): Promise<ExportResult> {
  const grouped = groupByMake(lines);
  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet;
  let headerRow = 1;
  if (opts.template) {
    await wb.xlsx.load(opts.template as unknown as ArrayBuffer);
    ws = wb.worksheets[0] ?? wb.addWorksheet("BOM");
    // The template's header row is the first row (within 10) whose column A says TEREX P/N; keep it, the rows above
    // it and the column widths; clear everything below it.
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      if (/TEREX\s*P\s*\/?\s*N/i.test(String(ws.getRow(r).getCell(1).value ?? ""))) {
        headerRow = r;
        break;
      }
    }
    if (ws.rowCount > headerRow) ws.spliceRows(headerRow + 1, ws.rowCount - headerRow);
  } else {
    ws = wb.addWorksheet("BOM");
  }
  wb.creator = "Panel BOM Pricer";
  wb.calcProperties = { fullCalcOnLoad: true };

  const widths = [14, 22, 12, 46, 20, 14, 7, 7, 13, 8, 13, 8, 15, 16];
  widths.forEach((w, i) => {
    const col = ws.getColumn(i + 1);
    if (!opts.template || !col.width) col.width = w;
  });

  // Header row: the A–N headers (the template's own wording is kept when present), yellow fill, bold.
  const header = ws.getRow(headerRow);
  TEMPLATE_HEADERS.forEach((h, i) => {
    const cell = header.getCell(i + 1);
    if (!String(cell.value ?? "").trim()) cell.value = h;
  });
  header.eachCell((c) => {
    c.font = { ...FONT, bold: true };
    c.fill = YELLOW;
    c.border = THIN;
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  header.height = 28;
  ws.views = [{ state: "frozen", ySplit: headerRow }];

  const layout: ExportLayout = {
    headerRow,
    makeHeaderRows: {},
    itemRows: {},
    subtotalRows: {},
    grandTotalRow: 0,
    summaryHeaderRow: 0,
    summaryRows: {},
  };

  let r = headerRow + 1;
  for (const g of grouped.groups) {
    // make header row
    const mh = ws.getRow(r);
    mh.getCell(1).value = g.make;
    ws.mergeCells(r, 1, r, 14);
    mh.getCell(1).font = { ...FONT, bold: true };
    mh.getCell(1).fill = MAKE_FILL;
    mh.getCell(1).border = THIN;
    layout.makeHeaderRows[g.make] = r;
    r++;

    const first = r;
    layout.itemRows[g.make] = [];
    for (const l of g.lines) {
      const row = ws.getRow(r);
      row.getCell(1).value = l.terexPn ?? null;
      row.getCell(2).value = l.whereUsed ?? null;
      row.getCell(3).value = l.drgSheetNo ?? null;
      row.getCell(4).value = l.description ?? null;
      row.getCell(5).value = l.mpn ?? null;
      row.getCell(6).value = l.make ? displayMake(l.make) : null;
      row.getCell(7).value = l.uom ?? null;
      row.getCell(8).value = l.qty;
      row.getCell(9).value = l.listPrice ?? null;
      row.getCell(10).value = l.disc ?? 0;
      row.getCell(11).value = { formula: `I${r}-(I${r}*J${r})`, result: l.unitPrice ?? 0 };
      row.getCell(12).value = l.margin ?? 0;
      row.getCell(13).value = { formula: `K${r}+(K${r}*L${r})`, result: l.terexUnitPrice ?? 0 };
      row.getCell(14).value = { formula: `H${r}*M${r}`, result: l.totalPrice };
      styleRow(row);
      row.getCell(4).alignment = { wrapText: true, vertical: "top" };
      row.getCell(2).alignment = { wrapText: true, vertical: "top" };
      for (const c of [9, 11, 13, 14]) row.getCell(c).numFmt = MONEY;
      for (const c of [10, 12]) row.getCell(c).numFmt = PCT;
      if (l.listPrice == null) {
        for (const c of [9, 11, 13, 14]) row.getCell(c).fill = YELLOW;
      }
      if (l.notes) {
        row.getCell(4).note = { texts: [{ text: l.notes }] } as ExcelJS.Comment;
      }
      layout.itemRows[g.make].push(r);
      r++;
    }
    const last = r - 1;
    const st = ws.getRow(r);
    st.getCell(4).value = `SUBTOTAL – ${g.make}`;
    st.getCell(14).value = { formula: `SUM(N${first}:N${last})`, result: g.subtotal };
    styleRow(st);
    for (let c = 1; c <= 14; c++) {
      st.getCell(c).fill = SUB_FILL;
      st.getCell(c).font = { ...FONT, bold: true };
    }
    st.getCell(14).numFmt = MONEY;
    layout.subtotalRows[g.make] = r;
    r++;
  }

  const gt = ws.getRow(r);
  const subRefs = Object.values(layout.subtotalRows).map((row) => `N${row}`);
  gt.getCell(4).value = "GRAND TOTAL";
  gt.getCell(14).value = { formula: subRefs.length ? subRefs.join("+") : "0", result: grouped.grandTotal };
  styleRow(gt);
  for (let c = 1; c <= 14; c++) {
    gt.getCell(c).fill = YELLOW;
    gt.getCell(c).font = { ...FONT, bold: true };
  }
  gt.getCell(14).numFmt = MONEY;
  layout.grandTotalRow = r;
  r += 3;

  // Summary table: Make | Line count | Subtotal | % of total  (columns D–G)
  const sh = ws.getRow(r);
  ["Make", "Line count", "Subtotal", "% of total"].forEach((h, i) => {
    const c = sh.getCell(4 + i);
    c.value = h;
    c.font = { ...FONT, bold: true };
    c.fill = YELLOW;
    c.border = THIN;
  });
  layout.summaryHeaderRow = r;
  r++;
  for (const s of grouped.summary) {
    const row = ws.getRow(r);
    const subRow = layout.subtotalRows[s.make];
    row.getCell(4).value = s.make;
    row.getCell(5).value = s.lineCount;
    row.getCell(6).value = { formula: `N${subRow}`, result: s.subtotal };
    row.getCell(7).value = {
      formula: `IF($N$${layout.grandTotalRow}=0,0,F${r}/$N$${layout.grandTotalRow})`,
      result: s.pct,
    };
    for (let c = 4; c <= 7; c++) {
      row.getCell(c).font = FONT;
      row.getCell(c).border = THIN;
    }
    row.getCell(6).numFmt = MONEY;
    row.getCell(7).numFmt = PCT;
    layout.summaryRows[s.make] = r;
    r++;
  }
  const tot = ws.getRow(r);
  tot.getCell(4).value = "TOTAL";
  tot.getCell(5).value = { formula: `SUM(E${layout.summaryHeaderRow + 1}:E${r - 1})`, result: lines.length };
  tot.getCell(6).value = { formula: `SUM(F${layout.summaryHeaderRow + 1}:F${r - 1})`, result: grouped.grandTotal };
  tot.getCell(7).value = { formula: `SUM(G${layout.summaryHeaderRow + 1}:G${r - 1})`, result: grouped.grandTotal > 0 ? 1 : 0 };
  for (let c = 4; c <= 7; c++) {
    tot.getCell(c).font = { ...FONT, bold: true };
    tot.getCell(c).border = THIN;
  }
  tot.getCell(6).numFmt = MONEY;
  tot.getCell(7).numFmt = PCT;

  if (opts.title) ws.headerFooter = { ...(ws.headerFooter ?? {}), oddHeader: `&L${opts.title.replace(/&/g, "&&")}` };
  const buffer = new Uint8Array(await wb.xlsx.writeBuffer());
  return { buffer, layout, grouped };
}
