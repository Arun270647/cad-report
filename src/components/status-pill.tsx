"use client";
import { cn } from "@/lib/utils";

/** Worker online/offline pill. `online === null` means "not known yet". */
export function StatusPill({ online, className }: { online: boolean | null; className?: string }) {
  const tone =
    online === null
      ? "border-slate-200 bg-slate-50 text-slate-600"
      : online
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-amber-200 bg-amber-50 text-amber-900";
  const dot = online === null ? "bg-slate-400" : online ? "bg-emerald-500" : "bg-amber-500";
  const label = online === null ? "Checking PC worker…" : online ? "PC worker online" : "PC worker offline — jobs will wait in the queue until it is back";
  return (
    <span role="status" className={cn("inline-flex max-w-full items-start gap-2 rounded-full border px-3 py-1 text-xs font-medium", tone, className)}>
      <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", dot, online && "animate-pulse")} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
