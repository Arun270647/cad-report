export function clean(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t === "" ? null : t;
}

export function normDeviceType(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase().replace(/[\s\-\/]+/g, "_");
}

/** "13 – 18 A" -> "13-18A", "13 to 18A" -> "13-18A", "0.5 KW" -> "0.5KW" */
export function normRating(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[‒–—―−~]/g, "-")
    .replace(/\s+TO\s+/g, "-")
    .replace(/\s+/g, "")
    .replace(/AMPS?\b/g, "A")
    .replace(/,/g, ".");
}

export function normMpn(s: string | null | undefined): string | null {
  const t = (s ?? "").toUpperCase().replace(/[\s\-_.\/]/g, "");
  return t === "" ? null : t;
}

export function normText(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[‒–—―−]/g, "-").replace(/\s+/g, "");
}

export function normQualifier(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[\s\-_\/]+/g, "");
}

const GENERIC_MAKES = /^(REPUTED|GENERIC|LABOU?R|NON[\s\-]?STOCK|LOCAL|MISC|SUNDR|CONSUMABLE|UNSPECIFIED)/i;
export function isGenericMake(make: string | null | undefined): boolean {
  const m = (make ?? "").trim();
  return m === "" || GENERIC_MAKES.test(m) || /LABOU?R|NON[\s\-]?STOCK/i.test(m);
}

export function displayMake(make: string | null | undefined): string {
  const m = (make ?? "").trim().toUpperCase();
  return m === "" ? "UNSPECIFIED" : m;
}

export function prettyDeviceType(dt: string): string {
  return dt.replace(/_/g, " ");
}

export function parseAmps(s: string | null | undefined): number | null {
  if (!s) return null;
  const nums = normRating(s).match(/\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  return Math.max(...nums.map(Number));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
