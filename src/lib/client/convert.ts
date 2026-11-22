"use client";
/**
 * Browser side of the job queue:
 *   render PDF pages → POST /api/jobs → upload page images → poll GET /api/jobs/:id → PageRecord[].
 * The price list never leaves the browser; only drawing page images are uploaded.
 */
import { openPdf, pageText, isReservedText, renderPage } from "./pdf-browser";
import type { PageRecord } from "../bom/types";
import type { CreateJobRequest, CreateJobResponse, JobPageView, JobView, UploadPageRequest } from "../contract";

/** Per-sheet progress shown as a badge. `stage` refines a "pending" page. */
export interface PageProgress extends PageRecord {
  stage?: "rendering" | "uploading" | "queued" | "reading" | "limit";
  /** stage "limit": Claude usage limit; retried automatically after this time */
  retryAt?: string;
}

export type ConversionPhase = "preparing" | "uploading" | "waiting" | "done";

export interface ConversionProgress {
  jobId: string | null;
  filename: string;
  phase: ConversionPhase;
  /** Pending pages of older jobs ahead of this job's first pending page (from the server). */
  queuePosition: number;
  pages: PageProgress[];
  /** Set while polling fails transiently (network/5xx); cleared on the next successful poll. */
  connectionIssue?: boolean;
}

export type ProgressFn = (p: ConversionProgress) => void;

export const LS_ACTIVE_JOB = "pbp.activeJob";
export const POLL_MS = 3000;
export const MAX_PAGES = 200;
const UPLOAD_CONCURRENCY = 2;
const UPLOAD_RETRIES = 3;
const BLANK_INK_RATIO = 0.002;

/* ───────────────────────── errors & HTTP ───────────────────────── */

/** Thrown after a 401; the browser is already being redirected to /login. */
export class AuthError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "AuthError";
  }
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === "AbortError" : (e as { name?: string } | null)?.name === "AbortError";
}

export function redirectToLogin(): void {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") window.location.replace("/login");
}

/** Exponential backoff: 1 s, 2 s, 4 s, … capped at 15 s. `attempt` starts at 1. */
export function backoffMs(attempt: number): number {
  return Math.min(15000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RequestOpts {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Extra attempts on network errors / 5xx. */
  retries?: number;
}

/**
 * JSON fetch with error handling. 401 → redirect to /login + AuthError. Network errors and 5xx are
 * retried `retries` times with backoff; other non-2xx responses throw HttpError with the server's message.
 */
export async function apiRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", body, signal, retries = 0 } = opts;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw abortError();
      if (attempt <= retries) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      throw new HttpError(0, "Network error — check your internet connection.");
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new AuthError();
    }
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return data as T;
    if (res.status >= 500 && attempt <= retries) {
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    const msg = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : null;
    throw new HttpError(res.status, msg ?? `Request failed (${res.status})`);
  }
}

/* ───────────────────────── active job (resume after reload) ───────────────────────── */

export interface ActiveJob {
  id: string;
  filename: string;
}
export function getActiveJob(): ActiveJob | null {
  try {
    const raw = localStorage.getItem(LS_ACTIVE_JOB);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ActiveJob>;
    return typeof v.id === "string" && typeof v.filename === "string" ? { id: v.id, filename: v.filename } : null;
  } catch {
    return null;
  }
}
export function setActiveJob(job: ActiveJob | null): void {
  try {
    if (job) localStorage.setItem(LS_ACTIVE_JOB, JSON.stringify(job));
    else localStorage.removeItem(LS_ACTIVE_JOB);
  } catch {
    /* storage unavailable — resume just won't work */
  }
}

/* ───────────────────────── pure mapping helpers ───────────────────────── */

function skipReasonFor(status: "blank" | "reserved"): string {
  return status === "reserved" ? "RESERVED sheet" : "Blank sheet";
}

/** Map one server page view to the badge/progress model. */
export function pageFromView(v: JobPageView): PageProgress {
  switch (v.status) {
    case "skipped":
      return { page: v.page, status: "skipped", skipReason: v.skipReason ?? "Skipped" };
    case "awaiting_upload":
      return { page: v.page, status: "pending", stage: "uploading" };
    case "pending":
      return { page: v.page, status: "pending", stage: "queued" };
    case "processing":
      return { page: v.page, status: "pending", stage: "reading" };
    case "waiting_limit":
      return { page: v.page, status: "pending", stage: "limit", retryAt: v.retryAt ?? undefined };
    case "error":
      return { page: v.page, status: "error", error: v.error ?? "Could not read this sheet" };
    case "done": {
      const r = v.result;
      if (!r) return { page: v.page, status: "error", error: "No result returned for this sheet" };
      if (r.sheet_status !== "content") return { page: v.page, status: "skipped", skipReason: skipReasonFor(r.sheet_status), sheet: r.sheet_number, mode: "image", result: r };
      return { page: v.page, status: "done", sheet: r.sheet_number, mode: "image", result: r };
    }
    default:
      return { page: v.page, status: "pending" };
  }
}

/** Final PageRecord[] (sorted by page) for aggregate(). */
export function recordsFromJob(job: JobView): PageRecord[] {
  return [...job.pages]
    .sort((a, b) => a.page - b.page)
    .map((v) => {
      const { stage: _stage, ...rec } = pageFromView(v);
      void _stage;
      return rec;
    });
}

export function isJobFinished(job: JobView): boolean {
  return job.status === "done";
}

/* ───────────────────────── main flow ───────────────────────── */

async function pollJob(jobId: string, filename: string, onProgress: ProgressFn, signal?: AbortSignal): Promise<PageRecord[]> {
  let failures = 0;
  for (;;) {
    let job: JobView | null = null;
    try {
      job = await apiRequest<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
      failures = 0;
    } catch (e) {
      if (isAbortError(e) || e instanceof AuthError) throw e;
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {
        setActiveJob(null);
        throw new Error("This job no longer exists (jobs are kept for 7 days). Please convert the drawing again.");
      }
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      failures++; // network / 5xx / 429: keep polling, the job lives on the server
    }
    if (job) {
      if (!isJobFinished(job) && job.pages.some((p) => p.status === "awaiting_upload")) {
        // Only possible when the upload was interrupted (tab closed/reloaded); the images are gone.
        setActiveJob(null);
        throw new Error("The upload of this drawing was interrupted before it finished. Please convert the drawing again.");
      }
      const done = isJobFinished(job);
      onProgress({
        jobId,
        filename: job.filename || filename,
        phase: done ? "done" : "waiting",
        queuePosition: job.queuePosition,
        pages: [...job.pages].sort((a, b) => a.page - b.page).map(pageFromView),
        connectionIssue: false,
      });
      if (done) {
        setActiveJob(null);
        return recordsFromJob(job);
      }
    } else {
      onProgress({ jobId, filename, phase: "waiting", queuePosition: 0, pages: [], connectionIssue: true });
    }
    await sleep(failures ? Math.max(POLL_MS, backoffMs(failures)) : POLL_MS, signal);
  }
}

/**
 * Convert a drawing through the job queue. Resolves with one PageRecord per PDF page once every page
 * is finished on the PC worker. Rejects with AbortError when `signal` aborts (polling stops; the job
 * keeps running on the server and can be resumed with resumeConversion).
 */
export async function runConversion(file: ArrayBuffer, filename: string, onProgress: ProgressFn, signal?: AbortSignal): Promise<PageRecord[]> {
  /* 1) analyse + render pages */
  const doc = await openPdf(file);
  try {
    if (doc.numPages > MAX_PAGES) throw new Error(`The PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}.`);
    const pages: PageProgress[] = Array.from({ length: doc.numPages }, (_, i) => ({ page: i + 1, status: "pending", stage: "rendering" }));
    let jobId: string | null = null;
    let phase: ConversionPhase = "preparing";
    const emit = () => onProgress({ jobId, filename, phase, queuePosition: 0, pages: pages.map((p) => ({ ...p })) });
    emit();

    // Rendered images are kept as Blobs (the browser may page large blobs out of RAM) until uploaded.
    const images = new Map<number, { blob: Blob; mediaType: UploadPageRequest["mediaType"] }>();
    for (const p of pages) {
      if (signal?.aborted) throw abortError();
      try {
        if (isReservedText(await pageText(doc, p.page))) {
          p.status = "skipped";
          p.skipReason = "RESERVED sheet";
          p.stage = undefined;
          emit();
          continue;
        }
      } catch {
        /* no text layer — render it */
      }
      const img = await renderPage(doc, p.page);
      if (img.inkRatio < BLANK_INK_RATIO) {
        p.status = "skipped";
        p.skipReason = "Blank sheet";
      } else {
        images.set(p.page, { blob: new Blob([img.data], { type: "text/plain" }), mediaType: img.mediaType });
        p.stage = "uploading";
      }
      if (p.status === "skipped") p.stage = undefined;
      emit();
    }

    /* 2) create the job */
    const req: CreateJobRequest = { filename, pages: pages.map((p) => ({ page: p.page, skipReason: p.status === "skipped" ? (p.skipReason ?? "Skipped") : null })) };
    let created: CreateJobResponse;
    try {
      created = await apiRequest<CreateJobResponse>("/api/jobs", { method: "POST", body: req, signal, retries: 2 });
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) throw new Error(e.message.startsWith("Request failed") ? "Too many jobs this hour — please try again later." : e.message);
      throw e;
    }
    if (!created || typeof created.id !== "string") throw new Error("The server did not return a job id.");
    jobId = created.id;
    setActiveJob({ id: jobId, filename });
    phase = "uploading";
    emit();

    /* 3) upload page images (2 at a time) */
    const queue = pages.filter((p) => images.has(p.page));
    let failed: Error | null = null;
    const uploader = async () => {
      while (queue.length && !failed) {
        const p = queue.shift()!;
        const img = images.get(p.page)!;
        try {
          const body: UploadPageRequest = { mediaType: img.mediaType, data: await img.blob.text() };
          try {
            await apiRequest<unknown>(`/api/jobs/${encodeURIComponent(jobId!)}/pages/${p.page}`, { method: "POST", body, signal, retries: UPLOAD_RETRIES });
          } catch (e) {
            // 409 = the page was already stored (e.g. an earlier attempt succeeded but the response was lost).
            if (!(e instanceof HttpError && e.status === 409)) throw e;
          }
          images.delete(p.page);
          p.stage = "queued";
          emit();
        } catch (e) {
          if (!failed) failed = isAbortError(e) || e instanceof AuthError ? (e as Error) : new Error(`Uploading sheet ${p.page} failed: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, uploader));
    images.clear();
    if (failed) throw failed;

    /* 4) + 5) poll until finished */
    phase = "waiting";
    emit();
    return await pollJob(jobId, filename, onProgress, signal);
  } finally {
    void doc.destroy().catch(() => undefined);
  }
}

/** Resume polling a job created earlier (e.g. after a page reload). Skips rendering and uploading. */
export async function resumeConversion(jobId: string, onProgress: ProgressFn, signal?: AbortSignal): Promise<PageRecord[]> {
  const filename = getActiveJob()?.id === jobId ? getActiveJob()!.filename : "";
  onProgress({ jobId, filename, phase: "waiting", queuePosition: 0, pages: [] });
  return pollJob(jobId, filename, onProgress, signal);
}
