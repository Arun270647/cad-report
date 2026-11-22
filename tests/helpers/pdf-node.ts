/** Node-side PDF helpers used by the tests (the app itself renders PDFs in the browser). */
import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

const require_ = createRequire(import.meta.url);

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;

async function getPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // Run the "fake worker" in-process (no worker threads in serverless functions).
      const g = globalThis as unknown as { pdfjsWorker?: unknown };
      if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function pdfjsAssetDir(sub: string): string {
  const pkg = path.dirname(require_.resolve("pdfjs-dist/package.json"));
  // pdfjs requires a trailing "/" (not "\") even on Windows.
  return path.join(pkg, sub).replace(/\\/g, "/") + "/";
}

async function openDoc(buf: Buffer) {
  const pdfjs = await getPdfJs();
  return pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: pdfjsAssetDir("standard_fonts"),
    cMapUrl: pdfjsAssetDir("cmaps"),
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
}

export interface PageText {
  page: number;
  text: string;
  wordCount: number;
}

export async function getPageCount(buf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  return doc.getPageCount();
}

export async function extractPageTexts(buf: Buffer): Promise<PageText[]> {
  const doc = await openDoc(buf);
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ page: i, text, wordCount: text ? text.split(" ").length : 0 });
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

/** Text heuristic: a sheet whose text is essentially just "RESERVED" (plus title block) is skipped. */
export function isReservedText(t: PageText): boolean {
  return /\bRESERVED\b/i.test(t.text) && t.wordCount <= 40;
}

/** Fallback when rasterising fails: a single-page PDF Claude can read natively. */
export async function singlePagePdf(buf: Buffer, pageNo: number): Promise<Buffer> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [pageNo - 1]);
  out.addPage(p);
  return Buffer.from(await out.save());
}
