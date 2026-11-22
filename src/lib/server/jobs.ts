import "server-only";
import { z } from "zod";
import type { JobStatus, PageStatus } from "@/lib/contract";
import type { Db } from "./db";

export const MAX_PAGES = 200;
export const MAX_IMAGE_B64 = 4_000_000;
export const MAX_ATTEMPTS = 3;
export const JOBS_PER_HOUR = 20;
export const JOB_RETENTION_DAYS = 7;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/* ---------- request validation ---------- */

export const CreateJobZod = z
  .object({
    filename: z.string().trim().min(1).max(200),
    pages: z
      .array(
        z.object({
          page: z.number().int().min(1).max(MAX_PAGES),
          skipReason: z.string().trim().min(1).max(500).nullable(),
        }),
      )
      .min(1)
      .max(MAX_PAGES),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    for (const p of v.pages) {
      if (seen.has(p.page)) {
        ctx.addIssue({ code: "custom", path: ["pages"], message: `Duplicate page number ${p.page}` });
        return;
      }
      seen.add(p.page);
    }
  });
export type CreateJobInput = z.output<typeof CreateJobZod>;

export interface PlannedJob {
  pageCount: number;
  status: JobStatus;
  pages: { page: number; status: Extract<PageStatus, "skipped" | "awaiting_upload">; skipReason: string | null }[];
}

/** Turn a validated CreateJobRequest into the rows to insert. page_count = highest page number. */
export function planJob(input: CreateJobInput): PlannedJob {
  const pages = [...input.pages]
    .sort((a, b) => a.page - b.page)
    .map((p) => ({
      page: p.page,
      status: p.skipReason !== null ? ("skipped" as const) : ("awaiting_upload" as const),
      skipReason: p.skipReason,
    }));
  const pageCount = pages[pages.length - 1]?.page ?? 0;
  const status: JobStatus = pages.every((p) => p.status === "skipped") ? "done" : "uploading";
  return { pageCount, status, pages };
}

export const PageParamsZod = z.object({
  id: z.string().refine(isUuid, "Invalid job id"),
  page: z.coerce.number().int().min(1).max(MAX_PAGES),
});

export const UploadPageZod = z.object({
  mediaType: z.enum(["image/png", "image/jpeg"]),
  data: z
    .string()
    .min(16)
    .max(MAX_IMAGE_B64)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "data must be plain base64"),
});

/** Decode base64 and check the magic bytes match the declared type. Returns null when they do not. */
export function decodeImage(mediaType: "image/png" | "image/jpeg", b64: string): Buffer | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mediaType === "image/png" ? !isPng : !isJpeg) return null;
  return buf;
}

export const WorkerResultZod = z.discriminatedUnion("ok", [
  z.object({
    jobId: z.string().refine(isUuid, "Invalid job id"),
    page: z.number().int().min(1).max(MAX_PAGES),
    ok: z.literal(true),
    result: z.unknown(),
    model: z.string().max(200).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    jobId: z.string().refine(isUuid, "Invalid job id"),
    page: z.number().int().min(1).max(MAX_PAGES),
    ok: z.literal(false),
    error: z.string().max(20_000),
    retryable: z.boolean(),
  }),
]);

/** Decide where a failed page goes. */
export function failureOutcome(retryable: boolean, attempts: number): "pending" | "error" {
  return retryable && attempts < MAX_ATTEMPTS ? "pending" : "error";
}

/* ---------- job status ---------- */

/** Item of GET /api/jobs (not part of contract.ts; response is { jobs: JobSummary[] }). */
export interface JobSummary {
  id: string;
  filename: string;
  status: JobStatus;
  createdAt: string;
  pageCount: number;
  counts: Omit<PageCounts, "started">;
}


export interface PageCounts {
  skipped: number;
  awaiting_upload: number;
  pending: number;
  processing: number;
  done: number;
  error: number;
  /** pages that have been claimed at least once (attempts > 0) */
  started: number;
}

/**
 * Job status rule (contract): uploading until every non-skipped page is uploaded, then queued;
 * processing once any page has been claimed; done when nothing is awaiting_upload/pending/processing.
 * MUST match the SQL in refreshJobStatus().
 */
export function deriveJobStatus(c: PageCounts): JobStatus {
  if (c.awaiting_upload > 0) return "uploading";
  if (c.pending + c.processing === 0) return "done";
  if (c.processing > 0 || c.done > 0 || c.error > 0 || c.started > 0) return "processing";
  return "queued";
}

export function countPages(pages: { status: PageStatus; attempts: number }[]): PageCounts {
  const c: PageCounts = { skipped: 0, awaiting_upload: 0, pending: 0, processing: 0, done: 0, error: 0, started: 0 };
  for (const p of pages) {
    c[p.status] += 1;
    if (p.attempts > 0) c.started += 1;
  }
  return c;
}

/** Recompute and persist bom.jobs.status from its pages (no-op when unchanged). */
export async function refreshJobStatus(db: Db, jobId: string): Promise<void> {
  await db`
    UPDATE bom.jobs j
       SET status = s.status, updated_at = now()
      FROM (
        SELECT CASE
                 WHEN bool_or(status = 'awaiting_upload') THEN 'uploading'
                 WHEN NOT bool_or(status IN ('pending', 'processing')) THEN 'done'
                 WHEN bool_or(status IN ('processing', 'done', 'error') OR attempts > 0) THEN 'processing'
                 ELSE 'queued'
               END AS status
          FROM bom.job_pages
         WHERE job_id = ${jobId}
      ) s
     WHERE j.id = ${jobId}
       AND s.status IS NOT NULL
       AND j.status IS DISTINCT FROM s.status`;
}
