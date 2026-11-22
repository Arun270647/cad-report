"use client";
import { Badge } from "@/components/ui";


const LINE: Record<string, { label: string; v: "default" | "success" | "warning" | "danger" | "info" | "purple" }> = {
  matched: { label: "Matched", v: "success" },
  conflict: { label: "Conflict", v: "danger" },
  not_found: { label: "Not in price list", v: "warning" },
  anomaly: { label: "Drawing anomaly", v: "purple" },
  manual: { label: "Manual", v: "info" },
};
export function LineChip({ status }: { status: string }) {
  const m = LINE[status] ?? { label: status, v: "default" as const };
  return <Badge variant={m.v}>{m.label}</Badge>;
}
