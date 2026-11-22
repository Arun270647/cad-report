import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, redactSecrets } from "@/lib/crypto";
import { normRating, isGenericMake } from "@/lib/bom/normalize";
import { matchGroup } from "@/lib/bom/matching";
import { groupByMake } from "@/lib/bom/grouping";
import { validateBom } from "@/lib/bom/validation";
import type { BomLine, ComponentGroup, PriceRow } from "@/lib/bom/types";

const key = crypto.randomBytes(32).toString("base64");

describe("crypto (AES-256-GCM)", () => {
  it("round-trips and uses a random IV", () => {
    const a = encryptSecret("sk-ant-test-1234", key);
    const b = encryptSecret("sk-ant-test-1234", key);
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-ant");
    expect(decryptSecret(a, key)).toBe("sk-ant-test-1234");
  });
  it("rejects tampered ciphertext and wrong keys", () => {
    const c = encryptSecret("secret", key);
    const parts = c.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
    expect(() => decryptSecret(c, crypto.randomBytes(32).toString("base64"))).toThrow();
  });
  it("redacts keys from log text", () => {
    expect(redactSecrets("bad key sk-ant-api03-abcDEF_123")).toBe("bad key sk-ant-***");
  });
});

describe("normalisation", () => {
  it("normalises ratings", () => {
    expect(normRating("13 – 18 A")).toBe("13-18A");
    expect(normRating("13 to 18A")).toBe("13-18A");
    expect(normRating("13—18 Amps")).toBe("13-18A");
  });
  it("classifies generic makes", () => {
    expect(isGenericMake("REPUTED")).toBe(true);
    expect(isGenericMake("Labour")).toBe(true);
    expect(isGenericMake("NON-STOCK")).toBe(true);
    expect(isGenericMake("SCHNEIDER")).toBe(false);
  });
});

const g = (over: Partial<ComponentGroup>): ComponentGroup => ({
  key: "k", deviceType: "MPCB", rating: "13-18A", ratingNorm: "13-18A", coilVoltage: null, poles: null, contactConfig: null,
  colour: null, fn: null, relayType: null, make: null, mpn: null, qty: 1, tags: ["Q1"], sheets: ["1"], descriptionHint: "MPCB 13-18A",
  anomaly: false, notes: [], ...over,
});
const row = (over: Partial<PriceRow>): PriceRow => ({
  rowNumber: 2, terexPn: null, whereUsed: null, drgSheetNo: null, description: null, mpn: null, mpnNorm: null, make: "SCHNEIDER",
  uom: "NOS", qty: 1, listPrice: 100, disc: 0.1, unitPrice: null, margin: null, terexUnitPrice: null, totalPrice: null, tagNo: null, ...over,
});

describe("matching (deterministic)", () => {
  it("never substitutes a different rating", () => {
    const items = [row({ description: "MPCB 17-23A GV2ME21", mpn: "GV2ME21", mpnNorm: "GV2ME21" })];
    const line = matchGroup(g({}), { rules: [], items, margin: 0.125 }, 1);
    expect(line.status).toBe("not_found");
    expect(line.listPrice).toBeNull();
  });
  it("matches by rule (device type + exact rating) and prefers rows with a Terex P/N", () => {
    const items = [
      row({ rowNumber: 2, mpn: "GV2ME20", mpnNorm: "GV2ME20", listPrice: 120 }),
      row({ rowNumber: 3, mpn: "GV2ME20", mpnNorm: "GV2ME20", listPrice: 100, terexPn: "TX1" }),
    ];
    const line = matchGroup(g({}), { rules: [{ deviceType: "MPCB", rating: "13–18A", qualifier: null, mpn: "GV2ME20" }], items, margin: 0.125 }, 1);
    expect(line.status).toBe("conflict");
    expect(line.terexPn).toBe("TX1");
    expect(line.listPrice).toBe(100);
    expect(line.alternatives).toHaveLength(2);
  });
  it("description fallback requires the exact rating token", () => {
    const items = [row({ description: "MPCB 113-18A", mpn: "X", mpnNorm: "X" }), row({ rowNumber: 3, description: "MPCB 13-18A", mpn: "Y", mpnNorm: "Y" })];
    const line = matchGroup(g({}), { rules: [], items, margin: 0.125 }, 1);
    expect(line.mpn).toBe("Y");
    expect(line.status).toBe("matched");
  });
});

describe("grouping + validation", () => {
  const base: BomLine = {
    position: 1, terexPn: null, whereUsed: null, drgSheetNo: null, description: "x", mpn: null, make: "ABB", uom: "NOS", qty: 2,
    listPrice: 100, disc: 0.5, margin: 0.1, status: "matched", flags: [], alternatives: [], notes: null, sourceKey: null, sourceCount: null,
  };
  it("computes K, M, N and orders makes with generics last", () => {
    const res = groupByMake([
      { ...base, position: 1, make: "REPUTED" },
      { ...base, position: 2, make: "SIEMENS" },
      { ...base, position: 3, make: "ABB" },
      { ...base, position: 4, make: "NON-STOCK" },
    ]);
    expect(res.groups.map((x) => x.make)).toEqual(["ABB", "SIEMENS", "NON-STOCK", "REPUTED"]);
    expect(res.groups[0].lines[0].totalPrice).toBeCloseTo(2 * 50 * 1.1);
    expect(res.grandTotal).toBeCloseTo(4 * 110);
  });
  it("blocks export on missing MAKE/UOM and conflicts", () => {
    const v = validateBom([{ ...base, make: null, uom: "", status: "conflict" }], null);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/MAKE is missing/);
    expect(v.errors.join(" ")).toMatch(/UOM is missing/);
    expect(v.errors.join(" ")).toMatch(/unresolved price conflict/);
  });
  it("flags quantity mismatch unless acknowledged", () => {
    const l = { ...base, sourceKey: "k", sourceCount: 2, qty: 3 };
    expect(validateBom([l], { totalDevices: 2 }).ok).toBe(false);
    expect(validateBom([l], { totalDevices: 2 }, { acknowledgeQuantityMismatch: true }).ok).toBe(true);
  });
});
