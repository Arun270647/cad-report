"use client";
import { openPdf, pageText, isReservedText, renderPage } from "./pdf-browser";
import type { PageExtraction, PageRecord } from "../bom/types";

export interface PageProgress extends PageRecord {
  stage?: "queued" | "rendering" | "reading" | "retrying";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PasscodeError extends Error {}

async function callExtract(page: number, img: { data: string; mediaType: string }, passcode: string | null) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(passcode ? { "x-app-passcode": passcode } : {}) },
      body: JSON.stringify({ page, ...img }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body as { result: PageExtraction; usage: { input: number; output: number }; model: string };
    if (res.status === 401 && body.code === "passcode") throw new PasscodeError("Passcode required");
    if ((res.status === 503 || res.status === 504 || body.retryable) && attempt < 4) {
      await sleep(5000 * attempt);
      continue;
    }
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}

/**
 * Convert a drawing: analyse every page, skip RESERVED/blank sheets, send the rest to Claude
 * (two sheets at a time) and report progress after each step.
 */
export async function extractDrawing(
  file: ArrayBuffer,
  onProgress: (pages: PageProgress[]) => void,
  passcode: string | null,
): Promise<{ pages: PageRecord[]; tokens: { input: number; output: number } }> {
  const doc = await openPdf(file);
  const pages: PageProgress[] = Array.from({ length: doc.numPages }, (_, i) => ({ page: i + 1, status: "pending", stage: "queued" }));
  const emit = () => onProgress(pages.map((p) => ({ ...p })));
  for (const p of pages) {
    try {
      if (isReservedText(await pageText(doc, p.page))) {
        p.status = "skipped";
        p.skipReason = "RESERVED sheet";
      }
    } catch {
      /* no text layer — fine */
    }
  }
  emit();
  const tokens = { input: 0, output: 0 };
  const queue = pages.filter((p) => p.status === "pending");
  let fatal: Error | null = null;
  async function worker() {
    while (queue.length && !fatal) {
      const p = queue.shift()!;
      try {
        p.stage = "rendering";
        emit();
        const img = await renderPage(doc, p.page);
        if (img.inkRatio < 0.002) {
          p.status = "skipped";
          p.skipReason = "Blank sheet";
          emit();
          continue;
        }
        p.stage = "reading";
        p.mode = "image";
        emit();
        const out = await callExtract(p.page, img, passcode);
        tokens.input += out.usage.input;
        tokens.output += out.usage.output;
        p.result = out.result;
        p.sheet = out.result.sheet_number;
        if (out.result.sheet_status !== "content") {
          p.status = "skipped";
          p.skipReason = out.result.sheet_status === "reserved" ? "RESERVED sheet" : "Blank sheet";
        } else p.status = "done";
      } catch (e) {
        if (e instanceof PasscodeError) {
          fatal = e;
          return;
        }
        p.status = "error";
        p.error = (e as Error).message;
        if (/API key/.test(p.error)) fatal = e as Error;
      }
      p.stage = undefined;
      emit();
    }
  }
  await Promise.all([worker(), worker()]);
  if (fatal) throw fatal;
  return { pages, tokens };
}
