import { requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { listJobs } from "@/lib/jobs";

export const GET = handle(async () => {
  await requireAdmin();
  return json({ jobs: await listJobs(undefined, 500) });
});
