import type { BomLine, DeviceCounts } from "./types";
import { groupByMake } from "./grouping";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  quantityMismatch: boolean;
}

/**
 * Pre-export validation. Errors block export. A quantity mismatch blocks too unless the
 * reviewer explicitly acknowledges it (they may have intentionally changed quantities).
 */
export function validateBom(
  lines: BomLine[],
  counts: Partial<DeviceCounts> | null,
  opts: { acknowledgeQuantityMismatch?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const grouped = groupByMake(lines);

  const sumSub = grouped.groups.reduce((s, g) => s + g.subtotal, 0);
  if (Math.abs(sumSub - grouped.grandTotal) > 0.005) errors.push("Grand total does not equal the sum of the subtotals");

  for (const g of grouped.groups) {
    for (const l of g.lines) {
      const label = `Line ${l.position} (${l.description ?? l.mpn ?? "?"})`;
      for (const v of [l.qty, l.listPrice, l.disc, l.margin, l.unitPrice, l.terexUnitPrice, l.totalPrice]) {
        if (v != null && !Number.isFinite(v)) {
          errors.push(`${label}: formula would produce an error (non-numeric value)`);
          break;
        }
      }
      if (l.disc != null && (l.disc < 0 || l.disc > 1)) errors.push(`${label}: discount must be between 0% and 100%`);
      if (!l.make?.trim()) errors.push(`${label}: MAKE is missing`);
      if (!l.uom?.trim()) errors.push(`${label}: UOM is missing`);
      if (!(l.qty > 0)) errors.push(`${label}: quantity must be greater than 0`);
      if (l.status === "conflict") errors.push(`${label}: unresolved price conflict`);
      if (l.listPrice == null) warnings.push(`${label}: no price (will be highlighted yellow)`);
    }
  }

  let quantityMismatch = false;
  const sourced = lines.filter((l) => l.sourceKey && l.sourceCount != null);
  if (counts?.totalDevices != null && sourced.length) {
    const qtySum = sourced.reduce((s, l) => s + l.qty, 0);
    const extracted = counts.totalDevices;
    const perLine = sourced.filter((l) => l.qty !== l.sourceCount);
    if (qtySum !== extracted || perLine.length) {
      quantityMismatch = true;
      const msg = `Quantity total of drawing-derived lines (${qtySum}) differs from extracted device count (${extracted})${
        perLine.length ? `; ${perLine.length} line(s) edited` : ""
      }`;
      if (opts.acknowledgeQuantityMismatch) warnings.push(msg + " — acknowledged");
      else errors.push(msg + " — acknowledge to continue");
    }
  }

  return { ok: errors.length === 0, errors, warnings, quantityMismatch };
}
