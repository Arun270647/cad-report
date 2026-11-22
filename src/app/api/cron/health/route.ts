import { handle, json } from "@/lib/api";
import { pingClaude } from "@/lib/claude";
import { getSettings } from "@/lib/settings";

export const maxDuration = 60;

/** Vercel Cron (see vercel.json: daily on Hobby; use "*/5 * * * *" on Pro). Vercel sends "Authorization: Bearer $CRON_SECRET". */
export const GET = handle(async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, 401);
  const s = await getSettings();
  if (!s.apiKeyCiphertext) return json({ ok: false, status: "not_configured" });
  try {
    const r = await pingClaude({ kind: "health" });
    return json({ ok: true, latencyMs: r.latencyMs });
  } catch {
    return json({ ok: false });
  }
});
