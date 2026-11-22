import type { BomLine } from "./types";
import { displayMake, isGenericMake } from "./normalize";

export interface ComputedLine extends BomLine {
  unitPrice: number | null; // K = I - I*J
  terexUnitPrice: number | null; // M = K + K*L
  totalPrice: number; // N = H*M
}

export interface MakeGroup {
  make: string;
  generic: boolean;
  lines: ComputedLine[];
  subtotal: number;
}

export interface GroupedBom {
  groups: MakeGroup[];
  grandTotal: number;
  summary: { make: string; lineCount: number; subtotal: number; pct: number }[];
}

export function computeLine(l: BomLine): ComputedLine {
  if (l.listPrice == null) return { ...l, unitPrice: null, terexUnitPrice: null, totalPrice: 0 };
  const I = l.listPrice;
  const J = l.disc ?? 0;
  const L = l.margin ?? 0;
  const K = I - I * J;
  const M = K + K * L;
  return { ...l, unitPrice: K, terexUnitPrice: M, totalPrice: (l.qty ?? 0) * M };
}

/**
 * CORE RULE: group by MAKE. Makes alphabetical; generic entries (REPUTED, labour, non-stock, blank)
 * go last. Each make has a subtotal; grand total = sum of subtotals.
 */
export function groupByMake(lines: BomLine[]): GroupedBom {
  const map = new Map<string, ComputedLine[]>();
  for (const l of [...lines].sort((a, b) => a.position - b.position)) {
    const make = displayMake(l.make);
    map.set(make, [...(map.get(make) ?? []), computeLine(l)]);
  }
  const groups: MakeGroup[] = [...map.entries()].map(([make, ls]) => ({
    make,
    generic: isGenericMake(make === "UNSPECIFIED" ? "" : make),
    lines: ls,
    subtotal: ls.reduce((s, l) => s + l.totalPrice, 0),
  }));
  groups.sort((a, b) => Number(a.generic) - Number(b.generic) || a.make.localeCompare(b.make));
  const grandTotal = groups.reduce((s, g) => s + g.subtotal, 0);
  const summary = groups.map((g) => ({
    make: g.make,
    lineCount: g.lines.length,
    subtotal: g.subtotal,
    pct: grandTotal > 0 ? g.subtotal / grandTotal : 0,
  }));
  return { groups, grandTotal, summary };
}
