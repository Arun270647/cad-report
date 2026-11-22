/**
 * Regression tests for aggregation using REAL output from local Claude Code (claude-opus-5-5, claude.ai login) on
 * samples/sample-drawing.pdf, captured 2026-11-22 in tests/fixtures/live-claude-extraction.json.
 *
 * Real output differs from the hand-written fixture in two ways that used to break the report:
 *  1. `function` is free text per instance ("Motor M1 starter"), which split identical parts into separate lines.
 *  2. Sheet 2 shows only "X1: 1 2 3 4" — X1's type/rating are drawn on sheet 4 — so 4 terminals went unpriced.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { aggregate } from "@/lib/bom/aggregate";
import { matchAll } from "@/lib/bom/matching";
import { parsePriceFile } from "@/lib/bom/pricefile";
import { buildWorkbook } from "@/lib/bom/excel";
import type { BomLine, ExtractedComponent, PageExtraction, PageRecord } from "@/lib/bom/types";

const root = path.resolve(__dirname, "..");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures", f), "utf8")) as Record<string, PageExtraction>;
const live = load("live-claude-extraction.json");
const handWritten = load("sample-extraction.json");
const priceXlsx = fs.readFileSync(path.join(root, "samples/sample-price-file.xlsx"));
const template = fs.readFileSync(path.join(root, "samples/sample-template.xlsx"));

function pagesFrom(src: Record<string, PageExtraction>): PageRecord[] {
  return [1, 2, 3, 4].map((p) =>
    p === 3 ? { page: 3, status: "skipped", skipReason: "RESERVED sheet" } : { page: p, status: "done", result: src[String(p)] },
  );
}

async function priced(src: Record<string, PageExtraction>): Promise<BomLine[]> {
  const { rows, rules } = await parsePriceFile(priceXlsx);
  return matchAll(aggregate(pagesFrom(src)).groups, { rules, items: rows, margin: 0.125 });
}

describe("aggregate on real Claude Code output", () => {
  it("fixture really has the free-text functions and the bare X1 strip this test is about", () => {
    expect(live["1"].components.find((c) => c.tag === "K1")?.function).toBe("Motor M1 starter");
    expect(live["2"].terminal_blocks).toEqual([expect.objectContaining({ tag: "X1", terminal_type: null, rating: null, count: 4 })]);
  });

  it("consolidates identical parts despite different free-text functions, keeping functions as a note", () => {
    const { groups } = aggregate(pagesFrom(live));
    const contactors18 = groups.filter((g) => g.deviceType === "CONTACTOR" && g.ratingNorm === "18A");
    expect(contactors18).toHaveLength(1);
    expect(contactors18[0].qty).toBe(2);
    expect(contactors18[0].tags.sort()).toEqual(["K1", "K2"]);
    expect(contactors18[0].fn).toBeNull();
    expect(contactors18[0].descriptionHint).not.toMatch(/Motor/);
    expect(contactors18[0].notes).toContain("Function: K1 Motor M1 starter; K2 Motor M2 starter");

    const mpcb = groups.filter((g) => g.deviceType === "MPCB" && g.ratingNorm === "13-18A");
    expect(mpcb).toHaveLength(1);
    expect(mpcb[0].qty).toBe(2);
    expect(mpcb[0].tags.sort()).toEqual(["Q1", "Q2"]);
  });

  it("resolves X1's terminal type/rating from sheet 4 for the bare X1 terminals on sheet 2", () => {
    const { groups, counts } = aggregate(pagesFrom(live));
    const terminals = groups.filter((g) => g.deviceType === "TERMINAL");
    expect(terminals.map((g) => [g.tags.join(","), g.fn, g.rating, g.qty]).sort()).toEqual([
      ["X1", "FEED-THROUGH", "2.5sqmm", 13],
      ["X2", "FEED-THROUGH", "4sqmm", 6],
    ]);
    expect(terminals.some((g) => !g.rating || !g.fn)).toBe(false);
    expect(counts.terminalsPerBlock).toEqual({ X1: 13, X2: 6 });
  });

  it("keeps every count and anomaly of the drawing", () => {
    const { counts, anomalies } = aggregate(pagesFrom(live));
    expect(counts.totalDevices).toBe(39);
    expect(counts.pilotLampsByColour).toEqual({ GREEN: 2, RED: 1, AMBER: 1 });
    expect(counts.pushbuttonsByFunction).toEqual({ START: 1, STOP: 1, "EMERGENCY STOP": 1 });
    expect(counts.relaysByType).toEqual({ "2C/O 24VDC": 2, "4C/O 230VAC": 1 });
    // No false duplicate-tag hits from function text; only the real H2 clash.
    expect(anomalies.map((a) => `${a.type}:${a.tags.join(",")}`).sort()).toEqual([
      "duplicate_tag:H2",
      "protection_below_flc:Q3",
      "terminal_clash:X1",
    ]);
  });

  it("prices the live output into the same consolidated lines as the hand-written fixture", async () => {
    const key = (l: BomLine) => [l.mpn ?? "-", l.qty, l.status, l.listPrice ?? "no price"].join(" | ");
    const fromLive = (await priced(live)).map(key).sort();
    const fromFixture = (await priced(handWritten)).map(key).sort();
    expect(fromLive).toHaveLength(18);
    expect(fromLive).toEqual(fromFixture);
    expect(fromLive.some((k) => k.startsWith("- |") && k.includes("not_found") && k.includes("| 4 |"))).toBe(false);
  });

  it("exports a group-by-make workbook with one row per consolidated line", async () => {
    const lines = await priced(live);
    const { buffer, layout, grouped } = await buildWorkbook(lines, { template, title: "live" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const itemRows = Object.values(layout.itemRows).flat();
    expect(itemRows).toHaveLength(lines.length);
    const lc1d18 = itemRows.filter((r) => ws.getCell(`E${r}`).value === "LC1D18BD");
    expect(lc1d18).toHaveLength(1);
    expect(ws.getCell(`H${lc1d18[0]}`).value).toBe(2);
    const makeOrder = Object.entries(layout.makeHeaderRows).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    expect(makeOrder.slice(0, 4)).toEqual(["FINDER", "PHOENIX CONTACT", "SCHNEIDER", "SIEMENS"]);
    const fixtureTotal = (await buildWorkbook(await priced(handWritten), { template, title: "fx" })).grouped.grandTotal;
    expect(grouped.grandTotal).toBeCloseTo(fixtureTotal, 6);
  });
});

describe("aggregate edge rules", () => {
  const comp = (o: Partial<ExtractedComponent>): ExtractedComponent => ({
    tag: null, device_type: "PUSHBUTTON", description: null, rating: null, setting: null, coil_voltage: null, poles: null,
    contact_config: null, colour: "GREEN", function: null, relay_type: null, quantity: 1, sheets: [], make: null,
    manufacturer_pn: null, motor_flc_a: null, motor_kw: null, ...o,
  });
  const page = (n: number, components: ExtractedComponent[], terminal_blocks: PageExtraction["terminal_blocks"] = []): PageRecord => ({
    page: n, status: "done",
    result: { sheet_number: String(n), sheet_title: null, sheet_status: "content", notes: [], components, terminal_blocks } as PageExtraction,
  });

  it("keeps a function shared by every unit (still describes the part) and counts functions per device", () => {
    const { groups, counts } = aggregate([page(1, [comp({ tag: "S1", function: "START" }), comp({ tag: "S5", function: "start" }), comp({ tag: "S6", function: "RESET" })])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].qty).toBe(3);
    expect(groups[0].fn).toBeNull(); // START + RESET differ → note instead
    expect(groups[0].notes[0]).toBe("Function: S1 START; S5 start; S6 RESET");
    expect(counts.pushbuttonsByFunction).toEqual({ START: 2, RESET: 1 });
    const same = aggregate([page(1, [comp({ tag: "S1", function: "START" }), comp({ tag: "S5", function: "START" })])]).groups[0];
    expect(same.fn).toBe("START");
    expect(same.descriptionHint).toMatch(/START$/);
  });

  it("does not guess a strip's terminal type when other sheets disagree; it flags the line instead", () => {
    const tb = (tag: string, terminal_type: string | null, rating: string | null, terminals: string[]) => ({ tag, terminal_type, rating, terminals, count: terminals.length });
    const { groups } = aggregate([
      page(1, [], [tb("X5", null, null, ["1", "2"])]),
      page(2, [], [tb("X5", "FEED-THROUGH", "2.5sqmm", ["3"])]),
      page(3, [], [tb("X5", "EARTH", "2.5sqmm", ["PE"])]),
    ]);
    const bare = groups.find((g) => g.deviceType === "TERMINAL" && !g.fn)!;
    expect(bare.qty).toBe(2);
    expect(bare.rating).toBe("2.5sqmm"); // rating agrees everywhere → inherited
    expect(bare.notes[0]).toMatch(/X5 on sheet 1: terminal type not shown/);
  });
});
