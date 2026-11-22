import { requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { ClaudeCallError, pingClaude } from "@/lib/claude";

export const maxDuration = 60;

export const POST = handle(async () => {
  const admin = await requireAdmin();
  try {
    const r = await pingClaude({ kind: "test", userId: admin.id });
    return json({ ok: true, latencyMs: r.latencyMs, model: r.model });
  } catch (e) {
    const err = e as ClaudeCallError;
    return json({ ok: false, errorType: err.errorType ?? "other", message: err.message ?? "Failed" });
  }
});
