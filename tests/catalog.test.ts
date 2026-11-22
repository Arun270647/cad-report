/**
 * Preloaded price list → catalog → Claude's catalog_id → priced, consolidated, group-by-make report.
 * Uses a SYNTHETIC consolidated file shaped like the real one (the real price list is private and lives only in
 * the database — never commit it).
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildCatalog, canonicalizeCatalogIds, catalogText, resolveCatalogRow } from "@/lib/bom/catalog";
import { canonicalMake, displayMake } from "@/lib/bom/normalize";
import { parsePriceFile } from "@/lib/bom/pricefile";
import { aggregate } from "@/lib/bom/aggregate";
import { matchAll } from "@/lib/bom/matching";
import { buildWorkbook } from "@/lib/bom/excel";
import type { ExtractedComponent, PageExtraction, PageRecord } from "@/lib/bom/types";

const HEAD = ["TEREX P/N", "WHERE USED", "DRG SHEET NO", "DESCRIPTION", "MANUFACTURE  P/N", "MAKE", "UOM", "QTY", "LIST PRICE", "Disc", "Unit price", "Margin", "Terex Unit price", "Total Price", "TAG  NO."];

/** [terexPn, description, mpn, make, uom, listPrice, disc] per row, starting at spreadsheet row 2. */
const ROWS: (string | number | null)[][] = [
  ["60722012", "Enclosure, 1000H X 2000W X 300D", "Rittal", null, "NO'S", 55000, -0.02], // r2: make typed in the P/N column
  ["60711002", "MOTOR PROTECTION CIRCUIT BREAKER, 3POLE, 13-18A", "GV2ME20", "SCHNEIDER", "NO'S", 14165, 0.64], // r3
  ["60711019", "MINIATURE CIRCUIT BREAKER, 2POLE, 4A, CURVE C", "A9N2P04C", "SCHENIDER", "NO'S", 2570, 0.72], // r4 (typo make)
  ["60713001", "POWER CONTACTOR, 18A, 3P, 24VDC COIL", "LC1D18BD", "SCHNEIDER", "NO'S", 4200, 0.6], // r5
  [null, "TERMINAL 2.5 SQ.MM FEED THROUGH", "3044076", "PHOENIX", "NO'S", 45, 0], // r6
  ["60711002", "MOTOR PROTECTION CIRCUIT BREAKER, 3POLE, 13-18A", "GV2ME20", "SCHNEIDER", "NO'S", 14165, 0.66], // r7: same P/N, later → wins
  [null, "BUSBAR, COPPER", "-", "REPUTED", "KG", 15000, 0], // r8: placeholder P/N
  [null, "Set of side panel 1800x400", "TS 8184.235", "RITAL", "NO'S", null, null], // r9: no price, make typo
];

async function consolidatedXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(HEAD);
  for (const [terex, desc, mpn, make, uom, lp, disc] of ROWS) ws.addRow([terex, null, null, desc, mpn, make, uom, 1, lp, disc]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Like the real template: row 1 empty, headers on row 2 (with the double-space spelling). */
async function templateXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getRow(2).values = HEAD.slice(0, 14);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const comp = (o: Partial<ExtractedComponent>): ExtractedComponent => ({
  tag: null, device_type: "OTHER", description: null, rating: null, setting: null, coil_voltage: null, poles: null,
  contact_config: null, colour: null, function: null, relay_type: null, quantity: 1, sheets: [], make: null,
  manufacturer_pn: null, motor_flc_a: null, motor_kw: null, catalog_id: null, ...o,
});
const page = (n: number, components: ExtractedComponent[], terminal_blocks: PageExtraction["terminal_blocks"] = []): PageRecord => ({
  page: n,
  status: "done",
  result: { sheet_number: String(n), sheet_title: null, sheet_status: "content", notes: [], components, terminal_blocks, catalog_version: "b".repeat(64) },
});

describe("catalog from the consolidated price list", () => {
  it("one entry per part; a repeated P/N keeps its LAST occurrence; placeholders de-duplicate by description", async () => {
    const { rows } = await parsePriceFile(await consolidatedXlsx());
    const cat = buildCatalog(rows);
    expect(cat.map((e) => e.id)).toEqual([2, 4, 5, 6, 7, 8, 9]); // row 3 (older GV2ME20) dropped in favour of row 7
    expect(cat.find((e) => e.id === 7)).toMatchObject({ mpn: "GV2ME20", make: "SCHNEIDER" });
    expect(cat.find((e) => e.id === 2)).toMatchObject({ make: "RITTAL", mpn: null }); // make moved out of the P/N column
    expect(cat.find((e) => e.id === 4)?.make).toBe("SCHNEIDER"); // typo merged
    const text = catalogText(cat);
    expect(text.split("\n")[0]).toBe("id | description | manufacturer P/N | make");
    expect(text).toContain("7 | MOTOR PROTECTION CIRCUIT BREAKER, 3POLE, 13-18A | GV2ME20 | SCHNEIDER");
  });

  it("resolves an id to the last row of its P/N (even if Claude names the older row)", async () => {
    const { rows } = await parsePriceFile(await consolidatedXlsx());
    expect(resolveCatalogRow(3, rows)?.rowNumber).toBe(7);
    expect(resolveCatalogRow(7, rows)?.disc).toBeCloseTo(0.66);
    expect(resolveCatalogRow(999, rows)).toBeNull();
  });

  it("merges make spelling variants", () => {
    expect(["Schenider", "L & T", "MENEKKES", "rital", "R", "POLYCABB", "Procon Controls", "Phoenix"].map(canonicalMake)).toEqual([
      "SCHNEIDER", "L&T", "MENNEKES", "RITTAL", "RITTAL", "POLYCAB", "PROCON", "PHOENIX CONTACT",
    ]);
    expect(displayMake("  ")).toBe("UNSPECIFIED");
    expect(displayMake("Jigo")).toBe("JIGO");
  });
});

describe("report from Claude's catalog choices (no review step)", () => {
  async function report(pages: PageRecord[]) {
    const { rows } = await parsePriceFile(await consolidatedXlsx());
    const { groups, counts } = aggregate(canonicalizeCatalogIds(pages, rows)); // exactly what the page does
    const lines = matchAll(groups, { rules: [], items: rows, margin: 0.125, catalogMode: true });
    return { lines, counts };
  }

  it("prices each line from exactly the chosen row and consolidates identical parts across sheets", async () => {
    const { lines } = await report([
      page(1, [
        comp({ tag: "Q1", device_type: "MPCB", rating: "13-18A", function: "Motor M1 protection", catalog_id: 7 }),
        comp({ tag: "Q2", device_type: "MPCB", rating: "13-18A", function: "Motor M2 protection", catalog_id: 3 }), // older row → same part
        comp({ tag: "K1", device_type: "CONTACTOR", rating: "18A", catalog_id: 5 }),
      ]),
      page(2, [comp({ tag: "F1", device_type: "MCB", rating: "4A", poles: "2P", catalog_id: 4 })]),
    ]);
    // Q1 picked row 7, Q2 picked the older row 3 of the same P/N → ONE line, priced from the last row.
    const mpcb = lines.filter((l) => l.mpn === "GV2ME20");
    expect(mpcb).toHaveLength(1);
    expect(mpcb[0]).toMatchObject({ qty: 2, whereUsed: "Q1, Q2", disc: 0.66, listPrice: 14165, terexPn: "60711002" });
    const mcb = lines.find((l) => l.mpn === "A9N2P04C")!;
    expect(mcb).toMatchObject({ make: "SCHNEIDER", status: "matched", qty: 1, whereUsed: "F1", drgSheetNo: "2", uom: "NO'S", margin: 0.125 });
    expect(mcb.description).toBe("MINIATURE CIRCUIT BREAKER, 2POLE, 4A, CURVE C");
  });

  it("same catalog id on several devices = ONE line with summed qty and all tags", async () => {
    const { lines } = await report([
      page(1, [comp({ tag: "K1", device_type: "CONTACTOR", rating: "18A", function: "Motor M1 starter", catalog_id: 5 })]),
      page(3, [comp({ tag: "K2", device_type: "CONTACTOR", rating: "18A", function: "Motor M2 starter", catalog_id: 5 })]),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mpn: "LC1D18BD", qty: 2, whereUsed: "K1, K2", drgSheetNo: "1, 3", listPrice: 4200 });
  });

  it("not in the catalog → unpriced, flagged, never substituted; unknown id → flagged", async () => {
    const { lines } = await report([
      page(1, [
        comp({ tag: "TH1", device_type: "THERMOSTAT", description: "THERMOSTAT 0-60C", catalog_id: null }),
        comp({ tag: "X9", device_type: "OTHER", description: "mystery", catalog_id: 12345 }),
      ]),
    ]);
    const th = lines.find((l) => l.whereUsed === "TH1")!;
    expect(th).toMatchObject({ status: "not_found", listPrice: null, mpn: null });
    expect(th.notes).toMatch(/Not in the preloaded price list/);
    expect(lines.find((l) => l.whereUsed === "X9")!.notes).toMatch(/row 12345 .* not in the current price list/);
  });

  it("a chosen row without a list price is kept but left unpriced with a note", async () => {
    const { lines } = await report([page(1, [comp({ device_type: "OTHER", description: "side panel", quantity: 2, catalog_id: 9 })])]);
    expect(lines[0]).toMatchObject({ mpn: "TS 8184.235", make: "RITTAL", qty: 2, listPrice: null });
    expect(lines[0].notes).toMatch(/row 9 has no list price/);
  });

  it("terminal strips: the catalog row given on one sheet applies to the same strip on other sheets", async () => {
    const tb = (tag: string, catalog_id: number | null, terminals: string[]) => ({ tag, terminal_type: null, rating: null, terminals, count: terminals.length, catalog_id });
    const { lines, counts } = await report([page(2, [], [tb("X1", null, ["1", "2", "3", "4"])]), page(4, [], [tb("X1", 6, ["5", "6", "7"])])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ mpn: "3044076", make: "PHOENIX CONTACT", qty: 7, listPrice: 45 });
    expect(counts.terminalsPerBlock).toEqual({ X1: 7 });
  });

  it("exports into the company template (header on row 2), grouped by make, live formulas", async () => {
    const { lines } = await report([
      page(1, [
        comp({ tag: "K1", device_type: "CONTACTOR", catalog_id: 5 }),
        comp({ tag: "K2", device_type: "CONTACTOR", catalog_id: 5 }),
        comp({ tag: "F1", device_type: "MCB", catalog_id: 4 }),
        comp({ tag: "W1", device_type: "OTHER", catalog_id: 8 }),
        comp({ tag: "TH1", device_type: "THERMOSTAT", catalog_id: null }),
      ]),
    ]);
    const { buffer, layout, grouped } = await buildWorkbook(lines, { template: await templateXlsx(), title: "drawing.pdf" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(layout.headerRow).toBe(2);
    expect(ws.getCell("A1").value).toBeNull();
    expect(ws.getCell("E2").value).toBe("MANUFACTURE  P/N"); // the template's own wording is kept
    const order = Object.entries(layout.makeHeaderRows).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    expect(order).toEqual(["SCHNEIDER", "REPUTED", "UNSPECIFIED"]);
    expect(layout.makeHeaderRows.SCHNEIDER).toBe(3);
    const lc = layout.itemRows.SCHNEIDER.find((r) => ws.getCell(`E${r}`).value === "LC1D18BD")!;
    expect(ws.getCell(`H${lc}`).value).toBe(2);
    expect(ws.getCell(`F${lc}`).value).toBe("SCHNEIDER");
    expect((ws.getCell(`N${lc}`).value as ExcelJS.CellFormulaValue).formula).toBe(`H${lc}*M${lc}`);
    // 2 × 4200 × (1 − 0.6) × 1.125 = 3780 ; 2570 × 0.28 × 1.125 = 809.55 ; 15000 × 1.125 = 16875
    expect(grouped.groups.find((g) => g.make === "SCHNEIDER")!.subtotal).toBeCloseTo(3780 + 809.55, 6);
    expect(grouped.grandTotal).toBeCloseTo(3780 + 809.55 + 16875, 6);
  });
});
