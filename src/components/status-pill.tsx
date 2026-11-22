"use client";
import type { StatusView } from "@/lib/contract";
import { cn } from "@/lib/utils";

/** Worker status pill. `status === null` means "not known yet". */
export function StatusPill({ status, className }: { status: StatusView | null; className?: string }) {
  let tone = "border-slate-200 bg-slate-50 text-slate-600";
  let dot = "bg-slate-400";
  let label = "Checking PC worker…";
  let pulse = false;
  if (status) {
    if (status.paused) {
      [tone, dot, label] = ["border-amber-200 bg-amber-50 text-amber-900", "bg-amber-500", "Conversions paused by an admin — new jobs wait in the queue"];
    } else if (status.limitUntil) {
      [tone, dot, label] = [
        "border-amber-200 bg-amber-50 text-amber-900",
        "bg-amber-500",
        `Waiting – Claude usage limit; resumes automatically at ${new Date(status.limitUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      ];
    } else if (status.workerState === "offline") {
      [tone, dot, label] = ["border-amber-200 bg-amber-50 text-amber-900", "bg-amber-500", "PC worker offline — jobs will wait in the queue until it is back"];
    } else if (status.workerState === "degraded") {
      [tone, dot, label] = ["border-amber-200 bg-amber-50 text-amber-900", "bg-amber-500", "PC worker needs attention — jobs may wait"];
    } else {
      [tone, dot, label, pulse] = ["border-emerald-200 bg-emerald-50 text-emerald-800", "bg-emerald-500", "PC worker online", true];
    }
  }
  return (
    <span role="status" className={cn("inline-flex max-w-full items-start gap-2 rounded-full border px-3 py-1 text-xs font-medium", tone, className)}>
      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", dot, pulse && "animate-pulse")} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
