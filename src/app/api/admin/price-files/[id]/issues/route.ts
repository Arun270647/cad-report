import { requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { priceRows } from "@/lib/jobs";
import { findPriceIssues } from "@/lib/bom/pricefile";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  return json({ issues: findPriceIssues(await priceRows(id)) });
});
