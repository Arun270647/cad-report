/**
 * Generates the seed/test data in samples/:
 *   - sample-drawing.pdf     4-sheet control panel drawing (sheet 3 is RESERVED)
 *   - sample-price-file.xlsx consolidated price file (includes one conflict + one duplicate)
 *   - sample-template.xlsx   output template, columns A–N
 * Run: npm run seed:samples
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import ExcelJS from "exceljs";

const OUT = path.join(process.cwd(), "samples");
fs.mkdirSync(OUT, { recursive: true });

function titleBlock(page: PDFPage, font: PDFFont, bold: PDFFont, sheet: number, title: string) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, borderWidth: 1.5, borderColor: rgb(0, 0, 0) });
  page.drawRectangle({ x: width - 320, y: 20, width: 300, height: 70, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  page.drawText("PNL-101 PUMP CONTROL PANEL", { x: width - 312, y: 70, size: 10, font: bold });
  page.drawText(title, { x: width - 312, y: 52, size: 9, font });
  page.drawText(`SHEET ${sheet} OF 4`, { x: width - 312, y: 32, size: 9, font: bold });
}

function device(page: PDFPage, font: PDFFont, x: number, y: number, lines: string[]) {
  page.drawRectangle({ x, y, width: 120, height: 46, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  lines.forEach((t, i) => page.drawText(t, { x: x + 5, y: y + 34 - i * 11, size: 8, font }));
}

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size: [number, number] = [1191, 842]; // A3 landscape

  // Sheet 1 — power circuit
  let p = doc.addPage(size);
  titleBlock(p, font, bold, 1, "POWER CIRCUIT");
  p.drawLine({ start: { x: 60, y: 760 }, end: { x: 1100, y: 760 }, thickness: 2 });
  device(p, font, 60, 680, ["Q0  MCCB 100A 4P", "INCOMER"]);
  [
    ["Q1  MPCB 13-18A", "SET 16A", "M1 7.5kW FLC 14.5A"],
    ["Q2  MPCB 13-18A", "SET 15A", "M2 7.5kW FLC 14.5A"],
    ["Q3  MPCB 4-6.3A", "SET 4A", "M3 2.2kW FLC 4.8A"],
  ].forEach((l, i) => device(p, font, 260 + i * 260, 600, l));
  [
    ["K1  CONTACTOR 18A", "3P COIL 24VDC"],
    ["K2  CONTACTOR 18A", "3P COIL 24VDC"],
    ["K3  CONTACTOR 9A", "3P COIL 24VDC"],
  ].forEach((l, i) => device(p, font, 260 + i * 260, 480, l));
  ["M1", "M2", "M3"].forEach((m, i) => {
    p.drawCircle({ x: 320 + i * 260, y: 380, size: 28, borderWidth: 1.5, borderColor: rgb(0, 0, 0) });
    p.drawText(m, { x: 312 + i * 260, y: 376, size: 10, font: bold });
  });

  // Sheet 2 — control circuit
  p = doc.addPage(size);
  titleBlock(p, font, bold, 2, "CONTROL CIRCUIT 24VDC");
  device(p, font, 60, 700, ["F1  MCB 6A 2P"]);
  device(p, font, 220, 700, ["T1  PSU 24VDC 5A"]);
  device(p, font, 60, 600, ["KA1 RELAY 2C/O", "COIL 24VDC"]);
  device(p, font, 220, 600, ["KA2 RELAY 2C/O", "COIL 24VDC"]);
  device(p, font, 380, 600, ["KA3 RELAY 4C/O", "COIL 230VAC"]);
  device(p, font, 60, 500, ["H1  LAMP GREEN", "RUN"]);
  device(p, font, 220, 500, ["H2  LAMP GREEN", "RUN"]);
  device(p, font, 380, 500, ["H2  LAMP RED", "TRIP"]);
  device(p, font, 540, 500, ["H4  LAMP AMBER", "OVERLOAD"]);
  device(p, font, 60, 400, ["S1  PB GREEN", "START"]);
  device(p, font, 220, 400, ["S2  PB RED", "STOP"]);
  device(p, font, 380, 400, ["S0  EMERGENCY STOP"]);
  device(p, font, 540, 400, ["TH1 THERMOSTAT", "0-60C"]);
  p.drawText("X1: 1 2 3 4", { x: 700, y: 720, size: 9, font });

  // Sheet 3 — reserved
  p = doc.addPage(size);
  titleBlock(p, font, bold, 3, "SPARE");
  p.drawText("RESERVED", { x: 480, y: 420, size: 48, font: bold, color: rgb(0.6, 0.6, 0.6) });

  // Sheet 4 — terminals
  p = doc.addPage(size);
  titleBlock(p, font, bold, 4, "TERMINAL LAYOUT");
  for (let t = 4; t <= 12; t++) {
    p.drawRectangle({ x: 80 + (t - 4) * 40, y: 600, width: 36, height: 80, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    p.drawText(String(t), { x: 92 + (t - 4) * 40, y: 636, size: 10, font });
  }
  p.drawText("X1  2.5 sqmm FEED-THROUGH", { x: 80, y: 700, size: 10, font: bold });
  for (let t = 1; t <= 6; t++) {
    p.drawRectangle({ x: 80 + (t - 1) * 40, y: 420, width: 36, height: 80, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    p.drawText(String(t), { x: 92 + (t - 1) * 40, y: 456, size: 10, font });
  }
  p.drawText("X2  4 sqmm FEED-THROUGH", { x: 80, y: 520, size: 10, font: bold });

  fs.writeFileSync(path.join(OUT, "sample-drawing.pdf"), await doc.save());
}

export const PRICE_HEADERS = [
  "TEREX P/N", "WHERE USED", "DRG SHEET NO", "DESCRIPTION", "MANUFACTURE P/N", "MAKE", "UOM", "QTY",
  "LIST PRICE", "Disc", "Unit price", "Margin", "Terex Unit price", "Total Price", "TAG NO",
];

// [terex, description, mpn, make, uom, list, disc]
const PRICE_ROWS: [string | null, string, string, string, string, number, number][] = [
  ["TX-1001", "MPCB 13-18A GV2", "GV2ME20", "SCHNEIDER", "NOS", 6500, 0.35],
  [null, "MPCB 13-18A (old quote)", "GV2ME20", "SCHNEIDER", "NOS", 6800, 0.35], // conflict: same P/N, different price
  ["TX-1002", "MPCB 4-6.3A GV2", "GV2ME10", "SCHNEIDER", "NOS", 5200, 0.35],
  ["TX-1003", "CONTACTOR 18A 3P 24VDC", "LC1D18BD", "SCHNEIDER", "NOS", 4200, 0.35],
  ["TX-1004", "CONTACTOR 9A 3P 24VDC", "LC1D09BD", "SCHNEIDER", "NOS", 3200, 0.35],
  ["TX-1005", "MCCB NSX100F 100A 4P", "LV429771", "SCHNEIDER", "NOS", 32000, 0.3],
  ["TX-1006", "PILOT LAMP GREEN 24V LED", "XB7NV63", "SCHNEIDER", "NOS", 450, 0.3],
  ["TX-1006", "PILOT LAMP GREEN 24V LED", "XB7NV63", "SCHNEIDER", "NOS", 450, 0.3], // duplicate (same price)
  ["TX-1007", "PILOT LAMP RED 24V LED", "XB7NV64", "SCHNEIDER", "NOS", 450, 0.3],
  ["TX-1008", "PILOT LAMP AMBER 24V LED", "XB7NV65", "SCHNEIDER", "NOS", 450, 0.3],
  ["TX-1009", "PUSHBUTTON GREEN START 1NO", "XB7NA31", "SCHNEIDER", "NOS", 380, 0.3],
  ["TX-1010", "PUSHBUTTON RED STOP 1NC", "XB7NA42", "SCHNEIDER", "NOS", 380, 0.3],
  ["TX-1011", "EMERGENCY STOP MUSHROOM 40MM", "XB7NS8445", "SCHNEIDER", "NOS", 1250, 0.3],
  ["TX-2001", "MCB 6A 2P C-CURVE", "5SL6206-7", "SIEMENS", "NOS", 900, 0.4],
  ["TX-2002", "POWER SUPPLY 24VDC 5A", "6EP1333-2BA20", "SIEMENS", "NOS", 9800, 0.25],
  ["TX-3001", "TERMINAL UT 2.5 2.5SQMM FEED-THROUGH", "3044076", "PHOENIX CONTACT", "NOS", 45, 0.2],
  ["TX-3002", "TERMINAL UT 4 4SQMM FEED-THROUGH", "3044131", "PHOENIX CONTACT", "NOS", 60, 0.2],
  ["TX-4001", "RELAY 2C/O 24VDC WITH BASE", "40.52.9.024.0000", "FINDER", "NOS", 350, 0.15],
  ["TX-4002", "RELAY 4C/O 230VAC WITH BASE", "55.34.8.230.0040", "FINDER", "NOS", 520, 0.15],
  [null, "PANEL WIRING LABOUR", "LAB-WIRING", "LABOUR", "LOT", 15000, 0],
  [null, "FERRULES, LUGS & SLEEVES", "MISC-FERRULE", "REPUTED", "LOT", 2500, 0],
];

async function makePriceFile() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Consolidated price list");
  ws.addRow(PRICE_HEADERS);
  PRICE_ROWS.forEach((r, i) => {
    const rowNo = i + 2;
    ws.addRow([
      r[0], null, null, r[1], r[2], r[3], r[4], 1, r[5], r[6],
      { formula: `I${rowNo}-(I${rowNo}*J${rowNo})`, result: r[5] * (1 - r[6]) },
      0.125,
      { formula: `K${rowNo}+(K${rowNo}*L${rowNo})`, result: r[5] * (1 - r[6]) * 1.125 },
      { formula: `H${rowNo}*M${rowNo}`, result: r[5] * (1 - r[6]) * 1.125 },
      null,
    ]);
  });
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 16));
  // Optional matching rules travel inside the price workbook (sheet name contains "RULES").
  const rs = wb.addWorksheet("RULES");
  rs.addRow(["Device type", "Rating", "Qualifier", "Manufacturer P/N"]);
  rs.getRow(1).font = { bold: true };
  for (const r of SAMPLE_RULES) rs.addRow([r.deviceType, r.rating, r.qualifier ?? "", r.mpn]);
  rs.columns.forEach((c) => (c.width = 20));
  await wb.xlsx.writeFile(path.join(OUT, "sample-price-file.xlsx"));
}

async function makeTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("BOM");
  ws.addRow(PRICE_HEADERS.slice(0, 14));
  ws.getRow(1).font = { name: "Calibri", size: 10, bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  [14, 22, 12, 46, 20, 14, 7, 7, 13, 8, 13, 8, 15, 16].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  await wb.xlsx.writeFile(path.join(OUT, "sample-template.xlsx"));
}

/** Matching rules used with the sample price file (also loaded by the E2E test). */
export const SAMPLE_RULES = [
  { deviceType: "MPCB", rating: "13-18A", qualifier: null, mpn: "GV2ME20" },
  { deviceType: "MPCB", rating: "4–6.3A", qualifier: null, mpn: "GV2ME10" },
  { deviceType: "CONTACTOR", rating: "18A", qualifier: "24VDC", mpn: "LC1D18BD" },
  { deviceType: "CONTACTOR", rating: "9A", qualifier: "24VDC", mpn: "LC1D09BD" },
  { deviceType: "MCCB", rating: "100A", qualifier: null, mpn: "LV429771" },
  { deviceType: "MCB", rating: "6A", qualifier: null, mpn: "5SL6206-7" },
  { deviceType: "POWER_SUPPLY", rating: "24VDC 5A", qualifier: null, mpn: "6EP1333-2BA20" },
  { deviceType: "CONTROL_RELAY", rating: "-", qualifier: "24VDC", mpn: "40.52.9.024.0000" },
  { deviceType: "CONTROL_RELAY", rating: "-", qualifier: "230VAC", mpn: "55.34.8.230.0040" },
  { deviceType: "PILOT_LAMP", rating: "-", qualifier: "GREEN", mpn: "XB7NV63" },
  { deviceType: "PILOT_LAMP", rating: "-", qualifier: "RED", mpn: "XB7NV64" },
  { deviceType: "PILOT_LAMP", rating: "-", qualifier: "AMBER", mpn: "XB7NV65" },
  { deviceType: "PUSHBUTTON", rating: "-", qualifier: "START", mpn: "XB7NA31" },
  { deviceType: "PUSHBUTTON", rating: "-", qualifier: "STOP", mpn: "XB7NA42" },
  { deviceType: "EMERGENCY_STOP", rating: "-", qualifier: null, mpn: "XB7NS8445" },
  { deviceType: "TERMINAL", rating: "2.5sqmm", qualifier: null, mpn: "3044076" },
  { deviceType: "TERMINAL", rating: "4sqmm", qualifier: null, mpn: "3044131" },
];

async function main() {
  await makePdf();
  await makePriceFile();
  await makeTemplate();
  fs.writeFileSync(path.join(OUT, "sample-rules.json"), JSON.stringify(SAMPLE_RULES, null, 2));
  console.log("Samples written to", OUT);
}

if (process.argv[1]?.endsWith("make-samples.ts")) main();
