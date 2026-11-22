import type { Job } from "./db/schema";

/** Job fields safe to send to the browser (no PDF bytes). */
export function publicJob(job: Job) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pdf, ...rest } = job;
  return rest;
}
export type PublicJob = ReturnType<typeof publicJob>;
