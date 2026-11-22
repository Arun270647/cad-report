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

/** Badge for one drawing sheet in the conversion progress list. */
export function SheetBadge({ p }: { p: { page: number; status: string; stage?: string; skipReason?: string; error?: string; retryAt?: string } }) {
  let label: string;
  let v: "default" | "success" | "warning" | "danger" | "info" | "purple";
  let title = p.skipReason ?? p.error ?? "";
  if (p.status === "done") [label, v] = ["done", "success"];
  else if (p.status === "skipped") [label, v] = [p.skipReason?.toLowerCase() ?? "skipped", "default"];
  else if (p.status === "error") [label, v] = ["error", "danger"];
  else if (p.stage === "rendering") [label, v] = ["rendering…", "info"];
  else if (p.stage === "uploading") [label, v] = ["uploading…", "info"];
  else if (p.stage === "reading") [label, v] = ["reading on PC…", "purple"];
  else if (p.stage === "limit") {
    [label, v] = ["Waiting – usage limit", "warning"];
    title = p.retryAt
      ? `Claude usage limit reached. Retried automatically after ${new Date(p.retryAt).toLocaleString()}.`
      : "Claude usage limit reached. Retried automatically.";
  } else [label, v] = ["waiting in queue", "warning"];
  return (
    <Badge variant={v} title={title}>
      Sheet {p.page}: {label}
    </Badge>
  );
}
