/**
 * Shared API contract between the browser, the Vercel API and the local worker.
 * See docs/CONTRACT.md for the full description.
 */
import type { PageExtraction } from "./bom/types";

/** waiting_limit = Claude plan usage limit hit; retried automatically at retryAt (does not use up an attempt). */
export type PageStatus = "skipped" | "awaiting_upload" | "pending" | "processing" | "waiting_limit" | "done" | "error";
export type JobStatus = "uploading" | "queued" | "processing" | "waiting_limit" | "done";

export interface JobPageView {
  page: number;
  status: PageStatus;
  skipReason: string | null;
  error: string | null;
  result: PageExtraction | null; // only when status === "done"
  retryAt?: string | null; // only when status === "waiting_limit"
}

export interface JobView {
  id: string;
  filename: string;
  status: JobStatus;
  createdAt: string;
  pages: JobPageView[];
  queuePosition: number; // queued pages of OLDER jobs that will be read before this job's pages
}

export type WorkerState = "online" | "degraded" | "offline";

export interface StatusView {
  workerOnline: boolean; // worker seen within the last 5 min (heartbeat every 60 s)
  workerState: WorkerState;
  workerLastSeen: string | null;
  pendingPages: number;
  paused: boolean; // conversions paused by an admin
  limitUntil: string | null; // Claude usage limit: the queue resumes at this time
  isAdmin: boolean;
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
  /** sha256 of the active price list; the worker fetches GET /api/worker/catalog when it changes. null = none. */
  catalogVersion?: string | null;
}
/** GET /api/worker/catalog → the price-list catalog Claude chooses catalog_id values from. */
export interface WorkerCatalog { version: string; count: number; text: string }

/* Reference data (preloaded; stored in the database, never in Git) */
export type ReferenceKind = "price_list" | "template";
export interface ReferenceMeta { filename: string; sha256: string; size: number; uploadedBy: string | null; uploadedAt: string }
/** GET /api/reference (signed-in) — file bytes come from GET /api/reference/:kind. */
export interface ReferenceView {
  priceList: (ReferenceMeta & { parts: number }) | null;
  template: ReferenceMeta | null;
  margin: number; // fraction, e.g. 0.125
}
export type WorkerFailureKind = "usage_limit" | "auth" | "limit" | "timeout" | "invalid_output" | "error";
export type WorkerResultRequest =
  | { jobId: string; page: number; ok: true; result: PageExtraction; model?: string; durationMs?: number }
  | { jobId: string; page: number; ok: false; error: string; retryable: boolean; kind?: WorkerFailureKind; retryAt?: string; durationMs?: number };

/** POST /api/worker/heartbeat (every 60 s). Response: { ok: true, paused: boolean }. */
export interface WorkerHeartbeatRequest {
  host: string;
  nodeVersion: string;
  claudeVersion: string;
  loginOk: boolean | null; // from `claude auth status` (uses no plan usage); null = unknown
  loginDetail: string | null; // e.g. "claude.ai (team)"
  limitUntil: string | null; // worker is waiting for a usage-limit reset until then
  lastPollAt: string | null;
  lastError: string | null;
  startedAt: string;
  busy: boolean;
}

/* Admin (session + ADMIN_EMAILS) */
export interface AdminJobRow {
  id: string;
  filename: string;
  email: string;
  status: JobStatus;
  createdAt: string;
  pages: number; // pages sent to Claude (not skipped)
  done: number;
  errors: number;
  waiting: number; // waiting_limit
  claudeMs: number; // sum of Claude Code time over finished pages
  wallMs: number | null; // created → last page finished (null while running)
  lastError: string | null;
}
export interface AdminAlert { kind: string; message: string; openedAt: string; resolvedAt: string | null }
export interface AdminWorkerView {
  state: WorkerState;
  reasons: string[];
  lastSeen: string | null;
  lastPoll: string | null;
  host: string | null;
  nodeVersion: string | null;
  claudeVersion: string | null;
  loginOk: boolean | null;
  loginDetail: string | null;
  limitUntil: string | null;
  lastError: string | null;
  startedAt: string | null;
  paused: boolean;
  pausedBy: string | null;
  pausedAt: string | null;
  queue: { pending: number; processing: number; waitingLimit: number };
  jobs: AdminJobRow[];
  alerts: AdminAlert[]; // open first, then the 10 most recent resolved
}
