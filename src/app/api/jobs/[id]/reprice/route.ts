import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { loadJobFor, repriceJob } from "@/lib/jobs";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const job = await loadJobFor(user, (await ctx.params).id);
  const created = await repriceJob(job, user);
  return json({ id: created.id }, 201);
});
