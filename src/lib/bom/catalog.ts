import type { PageExtraction, PriceRow } from "./types";
import { canonicalMake, clean, normMpn } from "./normalize";

/**
 * The catalog Claude chooses from: one entry per distinct part of the consolidated price list.
 *
 * Price policy (decided by the owner): when the same manufacturer P/N appears several times (the consolidated file
 * stacks several past BOMs), the LAST occurrence in the file wins. Rows without a real P/N are de-duplicated by
 * description + make, again keeping the last occurrence. The catalog id is that row's spreadsheet row number, so
 * the report can price a line from exactly one row — nothing is ever averaged or invented.
 */
export interface CatalogEntry {
  id: number; // spreadsheet row number of the chosen (last) occurrence
  description: string;
  mpn: string | null;
  make: string | null;
}

const NOT_A_PN = /^(-+|NA|N\/A|NIL|MATERIAL|FABRICATION|AS REQUIRED|REPUTED)$/i;

/** The P/N used for de-duplication, or null when the cell is empty / a placeholder. */
export function realMpn(r: Pick<PriceRow, "mpn">): string | null {
  const m = clean(r.mpn);
  if (!m || NOT_A_PN.test(m)) return null;
  return normMpn(m);
}

/**
 * Normalise obvious data-entry slips without changing the stored file:
 *   - MAKE written into the P/N column with MAKE empty (e.g. "Rittal") → make, P/N cleared
 *   - make spelling variants → canonical make
 */
export function tidyRow(r: PriceRow): PriceRow {
  let { make, mpn } = r;
  if (!clean(make) && mpn && canonicalMake(mpn) !== mpn.trim().toUpperCase()) {
    make = mpn;
    mpn = null;
  } else if (!clean(make) && mpn && /^[A-Z][A-Za-z&. ]{2,}$/.test(mpn.trim()) && !/\d/.test(mpn)) {
    make = mpn;
    mpn = null;
  }
  const out = { ...r, make: make ? canonicalMake(make) : null, mpn };
  out.mpnNorm = normMpn(mpn);
  return out;
}

/** Rows that can be offered to Claude (have a description), tidied. */
export function catalogRows(rows: PriceRow[]): PriceRow[] {
  return rows.filter((r) => clean(r.description)).map(tidyRow);
}

export function buildCatalog(rows: PriceRow[]): CatalogEntry[] {
  const last = new Map<string, PriceRow>();
  for (const r of [...catalogRows(rows)].sort((a, b) => a.rowNumber - b.rowNumber)) {
    const pn = realMpn(r);
    const k = pn ? `PN:${pn}` : `D:${(r.description ?? "").toUpperCase().replace(/\s+/g, " ").trim()}|${r.make ?? ""}`;
    last.set(k, r); // later rows overwrite earlier ones → last occurrence wins
  }
  return [...last.values()]
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .map((r) => ({ id: r.rowNumber, description: (r.description ?? "").replace(/\s+/g, " ").trim(), mpn: clean(r.mpn), make: r.make }));
}

/** Compact text sent to Claude with every page (one line per part). Pipes inside cells are replaced. */
export function catalogText(entries: CatalogEntry[]): string {
  const cell = (s: string | null) => (s ?? "").replace(/[|\r\n\t]+/g, " ").trim();
  return ["id | description | manufacturer P/N | make", ...entries.map((e) => `${e.id} | ${cell(e.description)} | ${cell(e.mpn)} | ${cell(e.make)}`)].join("\n");
}

/**
 * Map every catalog_id in the page results to its canonical row (the last occurrence of its P/N) BEFORE grouping,
 * so two ids that are the same part always consolidate into one line. Unknown ids are left as they are (the
 * matcher flags them).
 */
export function canonicalizeCatalogIds<T extends { result?: PageExtraction }>(pages: T[], rows: PriceRow[]): T[] {
  const memo = new Map<number, number>();
  const canon = (id: number | null | undefined) => {
    if (id == null) return id ?? null;
    if (!memo.has(id)) memo.set(id, resolveCatalogRow(id, rows)?.rowNumber ?? id);
    return memo.get(id)!;
  };
  return pages.map((p) =>
    p.result
      ? {
          ...p,
          result: {
            ...p.result,
            components: p.result.components.map((c) => ({ ...c, catalog_id: canon(c.catalog_id) })),
            terminal_blocks: p.result.terminal_blocks.map((t) => ({ ...t, catalog_id: canon(t.catalog_id) })),
          },
        }
      : p,
  );
}

/** The price row a catalog id resolves to (the last occurrence of its P/N), or null when the id is unknown. */
export function resolveCatalogRow(id: number, rows: PriceRow[]): PriceRow | null {
  const tidy = catalogRows(rows);
  const row = tidy.find((r) => r.rowNumber === id);
  if (!row) return null;
  const pn = realMpn(row);
  if (!pn) return row;
  const same = tidy.filter((r) => realMpn(r) === pn).sort((a, b) => a.rowNumber - b.rowNumber);
  return same[same.length - 1] ?? row;
}
