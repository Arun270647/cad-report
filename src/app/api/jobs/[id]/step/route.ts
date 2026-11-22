import { requireUser, HttpError } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { loadJobFor, stepJob } from "@/lib/jobs";
import { publicJob } from "@/lib/job-view";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const job = await loadJobFor(user, (await ctx.params).id);
  if (job.userId !== user.id) throw new HttpError(403, "Only the job owner can run it");
  const next = await stepJob(job, user);
  return json({ job: publicJob(next) });
});
