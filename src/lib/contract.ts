/**
 * Shared API contract between the browser, the Vercel API and the local worker.
 * See docs/CONTRACT.md for the full description.
 */
import type { PageExtraction } from "./bom/types";

export type PageStatus = "skipped" | "awaiting_upload" | "pending" | "processing" | "done" | "error";
export type JobStatus = "uploading" | "queued" | "processing" | "done";

export interface JobPageView {
  page: number;
  status: PageStatus;
  skipReason: string | null;
  error: string | null;
  result: PageExtraction | null; // only when status === "done"
}

export interface JobView {
  id: string;
  filename: string;
  status: JobStatus;
  createdAt: string;
  pages: JobPageView[];
  queuePosition: number; // number of pending pages from OTHER/older jobs ahead of this job's first pending page
}

export interface StatusView {
  workerOnline: boolean; // worker polled within the last 90 s
  workerLastSeen: string | null;
  pendingPages: number;
}

/* Browser → API */
export interface CreateJobRequest {
  filename: string;
  pages: { page: number; skipReason: string | null }[]; // skipReason set => page is "skipped" and never uploaded
}
export interface CreateJobResponse { id: string }
export interface UploadPageRequest { mediaType: "image/png" | "image/jpeg"; data: string /* base64, ≤ 4,000,000 chars */ }

/* Worker ↔ API (Authorization: Bearer WORKER_TOKEN) */
export interface WorkerTask {
  jobId: string;
  page: number;
  attempt: number;
  mediaType: "image/png" | "image/jpeg";
  data: string; // base64
}
export type WorkerResultRequest =
  | { jobId: string; page: number; ok: true; result: PageExtraction; model?: string; durationMs?: number }
  | { jobId: string; page: number; ok: false; error: string; retryable: boolean };
