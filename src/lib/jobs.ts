import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "./db";
import type { Job, JobLine } from "./db/schema";
import { HttpError } from "./auth";
import type { User } from "./db/schema";
import { extractPageTexts, isReservedText, renderPage, singlePagePdf, getPageCount } from "./pdf";
import { extractPage } from "./extraction";
import { ClaudeCallError, userFacingError } from "./claude";
import { aggregate } from "./bom/aggregate";
import { matchAll, repriceLine } from "./bom/matching";
import { budgetStatus, getSettings } from "./settings";
import type { BomLine, PageRecord, PriceRow, RuleLike } from "./bom/types";
import { isPdf } from "./api";

export async function loadJobFor(user: User, jobId: string): Promise<Job> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(404, "Job not found");
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job || (job.userId !== user.id && user.role !== "ADMIN")) throw new HttpError(404, "Job not found");
  return job;
}

export async function activePriceFile() {
  return db.query.priceFiles.findFirst({
    where: eq(schema.priceFiles.active, true),
    columns: { id: true, version: true, filename: true, createdAt: true },
  });
}

export async function priceRows(priceFileId: string): Promise<PriceRow[]> {
  const rows = await db.select().from(schema.priceItems).where(eq(schema.priceItems.priceFileId, priceFileId));
  return rows as PriceRow[];
}

export async function jobLines(jobId: string): Promise<JobLine[]> {
  return db.select().from(schema.jobLines).where(eq(schema.jobLines.jobId, jobId)).orderBy(asc(schema.jobLines.position));
}

export function toBomLine(l: JobLine): BomLine {
  return {
    id: l.id,
    position: l.position,
    terexPn: l.terexPn,
    whereUsed: l.whereUsed,
    drgSheetNo: l.drgSheetNo,
    description: l.description,
    mpn: l.mpn,
    make: l.make,
    uom: l.uom,
    qty: l.qty,
    listPrice: l.listPrice,
    disc: l.disc,
    margin: l.margin,
    status: l.status as BomLine["status"],
    flags: l.flags ?? [],
    alternatives: (l.alternatives ?? []) as BomLine["alternatives"],
    notes: l.notes,
    sourceKey: l.sourceKey,
    sourceCount: l.sourceCount,
  };
}

async function touch(jobId: string, patch: Partial<typeof schema.jobs.$inferInsert>) {
  await db.update(schema.jobs).set({ ...patch, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
}

/** Gatekeeper for starting conversions: maintenance mode, budget cap, configured key, active price file. */
export async function assertCanConvert() {
  const s = await getSettings();
  if (!s.conversionsEnabled) throw new HttpError(503, "Conversions are temporarily disabled (maintenance mode).");
  if (!s.apiKeyCiphertext) throw new HttpError(503, "The extraction service is not configured yet. Ask an administrator.");
  const b = await budgetStatus(s);
  if (b.level >= 100) throw new HttpError(402, "The monthly API budget has been reached. New conversions are blocked until an administrator raises the cap.");
  return s;
}

/**
 * Advance a job by ONE unit of work so every request stays well inside serverless time limits.
 * The browser calls this repeatedly and shows progress.
 */
export async function stepJob(job: Job, user: User): Promise<Job> {
  switch (job.status) {
    case "uploading": {
      const chunks = await db
        .select({ idx: schema.jobChunks.idx, data: schema.jobChunks.data })
        .from(schema.jobChunks)
        .where(eq(schema.jobChunks.jobId, job.id))
        .orderBy(asc(schema.jobChunks.idx));
      if (chunks.length !== job.chunkCount || chunks.some((c, i) => c.idx !== i)) throw new HttpError(409, "Upload incomplete");
      const pdf = Buffer.concat(chunks.map((c) => c.data));
      if (pdf.length !== job.fileSize || !isPdf(pdf)) {
        await touch(job.id, { status: "failed", error: "Uploaded file is not a valid PDF" });
        break;
      }
      await db.delete(schema.jobChunks).where(eq(schema.jobChunks.jobId, job.id));
      await touch(job.id, { pdf, status: "analyzing" });
      break;
    }
    case "analyzing": {
      // "Rendering pages" stage: page count + text layer → reserved-sheet detection
      const pdf = job.pdf!;
      let pageCount: number;
      try {
        pageCount = await getPageCount(pdf);
      } catch {
        await touch(job.id, { status: "failed", error: "Could not read the PDF (corrupt or encrypted)" });
        break;
      }
      if (pageCount > 150) {
        await touch(job.id, { status: "failed", error: "Drawing has more than 150 pages" });
        break;
      }
      let texts: Awaited<ReturnType<typeof extractPageTexts>> = [];
      try {
        texts = await extractPageTexts(pdf);
      } catch {
        texts = [];
      }
      const pages: PageRecord[] = Array.from({ length: pageCount }, (_, i) => {
        const t = texts[i];
        if (t && isReservedText(t)) return { page: i + 1, status: "skipped", skipReason: "RESERVED sheet" };
        return { page: i + 1, status: "pending" };
      });
      await touch(job.id, { pageCount, pages, pagesDone: 0, status: "extracting" });
      break;
    }
    case "extracting": {
      const pages = [...(job.pages as PageRecord[])];
      const idx = pages.findIndex((p) => p.status === "pending");
      if (idx === -1) {
        await touch(job.id, { status: "matching", pagesDone: pages.length });
        break;
      }
      const s = await getSettings();
      if (!s.conversionsEnabled) throw new HttpError(503, "Conversions are temporarily disabled (maintenance mode).");
      if ((await budgetStatus(s)).level >= 100) throw new HttpError(402, "Monthly API budget reached — conversion paused.");
      const rec: PageRecord = { ...pages[idx] };
      let png: Buffer | undefined;
      let pdfPage: Buffer | undefined;
      try {
        const r = await renderPage(job.pdf!, rec.page);
        if (r.inkRatio < 0.002) {
          rec.status = "skipped";
          rec.skipReason = "Blank sheet";
        } else {
          png = r.png;
          rec.mode = "image";
        }
      } catch (e) {
        console.warn("[jobs] render failed, falling back to single-page PDF:", String(e).slice(0, 200));
        pdfPage = await singlePagePdf(job.pdf!, rec.page);
        rec.mode = "pdf";
      }
      let costAdd = 0;
      if (rec.status === "pending") {
        try {
          const out = await extractPage({ page: rec.page, png, pdf: pdfPage, userId: job.userId, jobId: job.id });
          costAdd = out.costUsd;
          rec.result = out.value;
          rec.sheet = out.value.sheet_number;
          if (out.value.sheet_status !== "content") {
            rec.status = "skipped";
            rec.skipReason = out.value.sheet_status === "reserved" ? "RESERVED sheet" : "Blank sheet";
          } else rec.status = "done";
        } catch (e) {
          if (e instanceof ClaudeCallError && ["rate_limit", "overloaded", "timeout"].includes(e.errorType)) {
            // leave the page pending so the client can retry later
            throw new HttpError(503, userFacingError(e.errorType));
          }
          if (e instanceof ClaudeCallError && e.errorType === "auth") throw new HttpError(503, userFacingError("auth"));
          rec.status = "error";
          rec.error = e instanceof ClaudeCallError ? userFacingError(e.errorType) : "Extraction failed";
        }
      }
      pages[idx] = rec;
      const done = pages.filter((p) => p.status !== "pending").length;
      await db
        .update(schema.jobs)
        .set({ pages, pagesDone: done, costUsd: sql`${schema.jobs.costUsd} + ${costAdd}`, updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
      break;
    }
    case "matching": {
      await runMatching(job);
      break;
    }
    default:
      break;
  }
  void user;
  return (await db.query.jobs.findFirst({ where: eq(schema.jobs.id, job.id) }))!;
}

export async function runMatching(job: Job) {
  const pf = job.priceFileId ? { id: job.priceFileId } : await activePriceFile();
  const items = pf ? await priceRows(pf.id) : [];
  const rules = (await db.select().from(schema.matchingRules)) as RuleLike[];
  const pages = job.pages as PageRecord[];
  const { groups, counts, anomalies } = aggregate(pages);
  for (const p of pages.filter((x) => x.status === "error")) {
    anomalies.push({ type: "unreadable_sheet", message: `Page ${p.page}: ${p.error ?? "extraction failed"}`, tags: [], sheets: [String(p.page)] });
  }
  const lines = matchAll(groups, { rules, items, margin: job.margin });
  await db.transaction(async (tx) => {
    await tx.delete(schema.jobLines).where(eq(schema.jobLines.jobId, job.id));
    if (lines.length) await tx.insert(schema.jobLines).values(lines.map((l) => ({ ...l, id: undefined, jobId: job.id })));
    await tx
      .update(schema.jobs)
      .set({ counts: counts as unknown as Record<string, unknown>, anomalies, status: "review", priceFileId: pf?.id ?? null, updatedAt: new Date() })
      .where(eq(schema.jobs.id, job.id));
  });
}

/**
 * Re-price a past job against the latest active price file. Creates a NEW job (history is kept)
 * with the same reviewed lines, updated prices, and a changes report.
 */
export async function repriceJob(job: Job, user: User) {
  const pf = await activePriceFile();
  if (!pf) throw new HttpError(409, "No active price file");
  const items = await priceRows(pf.id);
  const old = (await jobLines(job.id)).map(toBomLine);
  const changes: { position: number; description: string | null; mpn: string | null; oldPrice: number | null; newPrice: number | null; oldDisc: number | null; newDisc: number | null; change: string }[] = [];
  const updated: BomLine[] = old.map((l) => {
    const { option, options } = repriceLine(l, items);
    if (!option) {
      if (l.mpn && l.listPrice != null) {
        changes.push({ position: l.position, description: l.description, mpn: l.mpn, oldPrice: l.listPrice, newPrice: null, oldDisc: l.disc, newDisc: null, change: "No longer in price list — price cleared" });
        return { ...l, listPrice: null, disc: null, status: "not_found", flags: [...new Set([...l.flags.filter((f) => f !== "conflict"), "not_found"])], notes: [l.notes, "Not in latest price list"].filter(Boolean).join("\n") };
      }
      return l;
    }
    const conflict = options.length > 1;
    const next: BomLine = {
      ...l,
      listPrice: option.listPrice,
      disc: option.disc,
      terexPn: option.terexPn ?? l.terexPn,
      alternatives: conflict ? options : [],
      flags: [...new Set([...l.flags.filter((f) => f !== "not_found" && f !== "conflict"), ...(conflict ? ["conflict"] : [])])],
    };
    next.status = conflict ? "conflict" : next.flags.includes("anomaly") ? "anomaly" : l.status === "manual" ? "manual" : "matched";
    if (option.listPrice !== l.listPrice || option.disc !== l.disc) {
      changes.push({ position: l.position, description: l.description, mpn: l.mpn, oldPrice: l.listPrice, newPrice: option.listPrice, oldDisc: l.disc, newDisc: option.disc, change: l.listPrice == null ? "Newly priced" : "Price changed" });
    }
    if (conflict) changes.push({ position: l.position, description: l.description, mpn: l.mpn, oldPrice: l.listPrice, newPrice: option.listPrice, oldDisc: l.disc, newDisc: option.disc, change: "Conflicting rows in new price file — please resolve" });
    return next;
  });
  const { groupByMake } = await import("./bom/grouping");
  const oldTotal = groupByMake(old).grandTotal;
  const newTotal = groupByMake(updated).grandTotal;
  const [created] = await db
    .insert(schema.jobs)
    .values({
      userId: user.id,
      filename: job.filename,
      status: "review",
      fileSize: job.fileSize,
      pageCount: job.pageCount,
      pagesDone: job.pagesDone,
      priceFileId: pf.id,
      margin: job.margin,
      pages: job.pages,
      anomalies: job.anomalies,
      counts: job.counts,
      parentJobId: job.id,
      changesReport: { fromJobId: job.id, priceFileVersion: pf.version, oldTotal, newTotal, changes },
    })
    .returning();
  if (updated.length) await db.insert(schema.jobLines).values(updated.map((l) => ({ ...l, id: undefined, jobId: created.id })));
  return created;
}

export async function listJobs(where?: { userId?: string }, limit = 100) {
  return db
    .select({
      id: schema.jobs.id,
      userId: schema.jobs.userId,
      email: schema.users.email,
      filename: schema.jobs.filename,
      status: schema.jobs.status,
      pageCount: schema.jobs.pageCount,
      costUsd: schema.jobs.costUsd,
      createdAt: schema.jobs.createdAt,
      approvedAt: schema.jobs.approvedAt,
      parentJobId: schema.jobs.parentJobId,
    })
    .from(schema.jobs)
    .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .where(where?.userId ? and(eq(schema.jobs.userId, where.userId)) : undefined)
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
}
