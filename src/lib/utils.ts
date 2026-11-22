import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmtMoney = (n: number | null | undefined, digits = 2) =>
  n == null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtPct = (n: number | null | undefined) => (n == null ? "" : `${(n * 100).toFixed(1)}%`);
export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString() : "");
