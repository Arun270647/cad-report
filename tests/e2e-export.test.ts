/**
 * End-to-end test of the conversion pipeline on the bundled sample data:
 *   sample PDF → page analysis (RESERVED sheet skipped) + rendering → extraction (Claude output
 *   replayed from a fixture) → aggregation & anomalies → deterministic matching against the sample
 *   price file → review edits → validation → Excel export.
 * It then re-opens the .xlsx and proves the group-by-make layout and that the LIVE formulas
 * evaluate to the expected subtotals and grand total.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractPageTexts, isReservedText } from "./helpers/pdf-node";
import { aggregate } from "@/lib/bom/aggregate";
import { matchAll } from "@/lib/bom/matching";
import { parsePriceFile, findPriceIssues } from "@/lib/bom/pricefile";
import { buildWorkbook, TEMPLATE_HEADERS } from "@/lib/bom/excel";
import { validateBom } from "@/lib/bom/validation";
import type { BomLine, PageExtraction, PageRecord, RuleLike } from "@/lib/bom/types";

const root = path.resolve(__dirname, "..");
const pdf = fs.readFileSync(path.join(root, "samples/sample-drawing.pdf"));
const priceXlsx = fs.readFileSync(path.join(root, "samples/sample-price-file.xlsx"));
const template = fs.readFileSync(path.join(root, "samples/sample-template.xlsx"));
const rulesJson = JSON.parse(fs.readFileSync(path.join(root, "samples/sample-rules.json"), "utf8")) as RuleLike[];
const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/sample-extraction.json"), "utf8")) as Record<string, PageExtraction>;

/** Tiny evaluator for the formulas we emit (cell refs, + - * /, parentheses, SUM(range), IF(x=0,0,y)). */
function evaluate(ws: ExcelJS.Worksheet, formula: string, depth = 0): number {
  if (depth > 20) throw new Error("formula recursion");
  const val = (ref: string): number => {
    const cell = ws.getCell(ref.replace(/\$/g, ""));
    const v = cell.value as ExcelJS.CellValue;
    if (v && typeof v === "object" && "formula" in v) return evaluate(ws, (v as ExcelJS.CellFormulaValue).formula, depth + 1);
    return typeof v === "number" ? v : 0;
  };
  let f = formula.replace(/^=/, "");
  f = f.replace(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/g, (_m, c1, r1, _c2, r2) => {
    let s = 0;
    for (let r = Number(r1); r <= Number(r2); r++) s += val(`${c1}${r}`);
    return `(${s})`;
  });
  const ifm = f.match(/^IF\((.+)=0,0,(.+)\)$/);
  if (ifm) {
    const cond = evaluate(ws, ifm[1], depth + 1);
    return cond === 0 ? 0 : evaluate(ws, ifm[2], depth + 1);
  }
  f = f.replace(/\$?[A-Z]{1,2}\$?\d+/g, (ref) => `(${val(ref)})`);
  if (!/^[\d.()+\-*/\se]+$/.test(f)) throw new Error(`unsupported formula: ${formula}`);
  return Function(`"use strict"; return (${f});`)() as number;
}

describe("end-to-end: sample drawing → priced BOM export", () => {
  it("runs the full pipeline and produces a correct group-by-make workbook", async () => {
    // 1) Page analysis: the RESERVED sheet is skipped before any API call
    const texts = await extractPageTexts(pdf);
    expect(texts).toHaveLength(4);
    const skipped = texts.filter(isReservedText).map((t) => t.page);
    expect(skipped).toEqual([3]);

    // 3) Extraction results (fixture replays what the Claude API returns per sheet)
    const pages: PageRecord[] = texts.map((t) =>
      skipped.includes(t.page)
        ? { page: t.page, status: "skipped", skipReason: "RESERVED sheet" }
        : { page: t.page, status: "done", result: fixture[String(t.page)] },
    );

    // 4) Aggregation, counts and anomalies
    const { groups, counts, anomalies } = aggregate(pages);
    expect(counts.totalDevices).toBe(39); // 20 tagged devices + 19 terminals
    expect(counts.pilotLampsByColour).toEqual({ GREEN: 2, RED: 1, AMBER: 1 });
    expect(counts.pushbuttonsByFunction).toEqual({ START: 1, STOP: 1, "EMERGENCY STOP": 1 });
    expect(counts.relaysByType).toEqual({ "2C/O 24VDC": 2, "4C/O 230VAC": 1 });
    expect(counts.terminalsPerBlock).toEqual({ X1: 13, X2: 6 });
    expect(anomalies.map((a) => a.type).sort()).toEqual(["duplicate_tag", "protection_below_flc", "terminal_clash"]);
    expect(anomalies.find((a) => a.type === "protection_below_flc")!.tags).toEqual(["Q3"]);

    // 5) Price file parsing + duplicate/conflict detection
    const { rows, rules } = await parsePriceFile(priceXlsx);
    expect(rows).toHaveLength(21);
    expect(rules).toHaveLength(rulesJson.length); // RULES sheet inside the price workbook
    const issues = findPriceIssues(rows);
    expect(issues.find((i) => i.mpn === "GV2ME20")?.kind).toBe("conflict");
    expect(issues.find((i) => i.mpn === "XB7NV63")?.kind).toBe("duplicate");

    // 6) Deterministic matching
    const lines = matchAll(groups, { rules, items: rows, margin: 0.125 });
    const mpcb = lines.find((l) => l.description?.includes("13-18A"))!;
    expect(mpcb.status).toBe("conflict");
    expect(mpcb.terexPn).toBe("TX-1001"); // preselects the row that has a Terex P/N
    expect(mpcb.alternatives).toHaveLength(2);
    expect(mpcb.qty).toBe(2);
    const thermostat = lines.find((l) => l.sourceKey?.startsWith("THERMOSTAT"))!;
    expect(thermostat.status).toBe("not_found");
    expect(thermostat.listPrice).toBeNull(); // never substituted
    expect(lines.find((l) => l.mpn === "GV2ME10")!.status).toBe("anomaly");

    // Export must be blocked while a conflict is unresolved / MAKE missing
    const pre = validateBom(lines, counts);
    expect(pre.ok).toBe(false);
    expect(pre.errors.some((e) => e.includes("unresolved price conflict"))).toBe(true);

    // 7) Review edits: resolve conflict, fill MAKE for the unpriced line, add labour & sundries
    const reviewed: BomLine[] = lines.map((l) =>
      l === mpcb ? { ...l, status: "matched", flags: [] } : l === thermostat ? { ...l, make: "REPUTED" } : l,
    );
    const nextPos = reviewed.length + 1;
    reviewed.push(
      { ...thermostat, position: nextPos, description: "PANEL WIRING LABOUR", mpn: "LAB-WIRING", make: "LABOUR", uom: "LOT", qty: 1, listPrice: 15000, disc: 0, status: "manual", flags: ["manual"], notes: null, sourceKey: null, sourceCount: null },
      { ...thermostat, position: nextPos + 1, description: "FERRULES, LUGS & SLEEVES", mpn: "MISC-FERRULE", make: "REPUTED", uom: "LOT", qty: 1, listPrice: 2500, disc: 0, status: "manual", flags: ["manual"], notes: null, sourceKey: null, sourceCount: null },
    );
    const v = validateBom(reviewed, counts);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("no price"))).toBe(true);

    // 8) Export with the uploaded template and re-open the workbook
    const { buffer, layout, grouped } = await buildWorkbook(reviewed, { template, title: "sample-drawing.pdf" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];

    // header row A–N, yellow, Calibri 10 bold
    TEMPLATE_HEADERS.forEach((h, i) => expect(ws.getRow(1).getCell(i + 1).value).toBe(h));
    expect((ws.getCell("A1").fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFFF00");
    expect(ws.getCell("A1").font?.name).toBe("Calibri");
    expect(ws.getCell("A1").font?.size).toBe(10);

    // GROUP BY MAKE: alphabetical, generic (LABOUR, REPUTED) last
    const makeOrder = Object.entries(layout.makeHeaderRows).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    expect(makeOrder).toEqual(["FINDER", "PHOENIX CONTACT", "SCHNEIDER", "SIEMENS", "LABOUR", "REPUTED"]);
    for (const m of makeOrder) {
      const hdr = layout.makeHeaderRows[m];
      expect(ws.getCell(`A${hdr}`).value).toBe(m); // make header row
      const items = layout.itemRows[m];
      expect(items[0]).toBe(hdr + 1);
      for (const r of items) {
        expect(ws.getCell(`F${r}`).value).toBe(m === "UNSPECIFIED" ? null : m);
        expect((ws.getCell(`K${r}`).value as ExcelJS.CellFormulaValue).formula).toBe(`I${r}-(I${r}*J${r})`);
        expect((ws.getCell(`M${r}`).value as ExcelJS.CellFormulaValue).formula).toBe(`K${r}+(K${r}*L${r})`);
        expect((ws.getCell(`N${r}`).value as ExcelJS.CellFormulaValue).formula).toBe(`H${r}*M${r}`);
        expect(ws.getCell(`J${r}`).numFmt).toBe("0.0%");
        expect(ws.getCell(`N${r}`).numFmt).toBe("#,##0.00");
        expect(ws.getCell(`D${r}`).border?.top?.style).toBe("thin");
      }
      const sub = layout.subtotalRows[m];
      expect(sub).toBe(items[items.length - 1] + 1);
      expect((ws.getCell(`N${sub}`).value as ExcelJS.CellFormulaValue).formula).toBe(`SUM(N${items[0]}:N${items[items.length - 1]})`);
      expect(String(ws.getCell(`D${sub}`).value)).toContain("SUBTOTAL");
    }

    // Expected values computed by hand from the sample price file (margin 12.5%)
    const expectedSubtotals: Record<string, number> = {
      FINDER: 669.375 + 497.25,
      "PHOENIX CONTACT": 526.5 + 324,
      SCHNEIDER: 25200 + 9506.25 + 3802.5 + 6142.5 + 2340 + 708.75 + 354.375 + 354.375 + 299.25 + 299.25 + 984.375,
      SIEMENS: 607.5 + 8268.75,
      LABOUR: 16875,
      REPUTED: 2812.5,
    };
    const expectedGrand = Object.values(expectedSubtotals).reduce((a, b) => a + b, 0);
    expect(expectedGrand).toBeCloseTo(80572.5, 6);

    // Live formulas evaluate to the expected numbers
    let sumOfSubtotals = 0;
    for (const m of makeOrder) {
      const subVal = evaluate(ws, (ws.getCell(`N${layout.subtotalRows[m]}`).value as ExcelJS.CellFormulaValue).formula);
      expect(subVal).toBeCloseTo(expectedSubtotals[m], 6);
      sumOfSubtotals += subVal;
    }
    const gtFormula = (ws.getCell(`N${layout.grandTotalRow}`).value as ExcelJS.CellFormulaValue).formula;
    expect(gtFormula).toBe(makeOrder.map((m) => `N${layout.subtotalRows[m]}`).join("+"));
    const grand = evaluate(ws, gtFormula);
    expect(grand).toBeCloseTo(expectedGrand, 6);
    expect(grand).toBeCloseTo(sumOfSubtotals, 9); // grand total == sum of subtotals
    expect(grouped.grandTotal).toBeCloseTo(expectedGrand, 6);
    expect((ws.getCell(`N${layout.grandTotalRow}`).value as ExcelJS.CellFormulaValue).result).toBeCloseTo(expectedGrand, 6);

    // Summary table: Make | Line count | Subtotal | % of total
    expect(["Make", "Line count", "Subtotal", "% of total"]).toEqual([4, 5, 6, 7].map((c) => ws.getRow(layout.summaryHeaderRow).getCell(c).value));
    let pctSum = 0;
    for (const m of makeOrder) {
      const r = layout.summaryRows[m];
      expect(ws.getCell(`D${r}`).value).toBe(m);
      expect(ws.getCell(`E${r}`).value).toBe(layout.itemRows[m].length);
      expect(evaluate(ws, (ws.getCell(`F${r}`).value as ExcelJS.CellFormulaValue).formula)).toBeCloseTo(expectedSubtotals[m], 6);
      const pct = evaluate(ws, (ws.getCell(`G${r}`).value as ExcelJS.CellFormulaValue).formula);
      expect(pct).toBeCloseTo(expectedSubtotals[m] / expectedGrand, 9);
      pctSum += pct;
    }
    expect(pctSum).toBeCloseTo(1, 9);

    // Unpriced cells are yellow and notes become cell comments
    const thermoRow = layout.itemRows["REPUTED"].find((r) => ws.getCell(`I${r}`).value == null)!;
    expect(thermoRow).toBeDefined();
    expect((ws.getCell(`I${thermoRow}`).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFFF00");
    expect(ws.getCell(`D${thermoRow}`).note).toBeTruthy();

    // No formula errors anywhere: every formula cell evaluates to a finite number
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        const v = cell.value as ExcelJS.CellValue;
        if (v && typeof v === "object" && "formula" in v) {
          expect(Number.isFinite(evaluate(ws, (v as ExcelJS.CellFormulaValue).formula))).toBe(true);
        }
      }),
    );

    // Quantity totals match extracted device counts
    const sourcedQty = reviewed.filter((l) => l.sourceKey).reduce((s, l) => s + l.qty, 0);
    expect(sourcedQty).toBe(counts.totalDevices);
  });
});
