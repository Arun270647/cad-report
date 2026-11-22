import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

const require_ = createRequire(import.meta.url);

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;

async function getPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Share ONE @napi-rs/canvas instance with pdf.js (it polyfills Path2D/DOMMatrix/ImageData from it).
      const canvas = require_("@napi-rs/canvas");
      const g0 = globalThis as Record<string, unknown>;
      for (const k of ["Path2D", "DOMMatrix", "ImageData"]) if (!g0[k] && canvas[k]) g0[k] = canvas[k];
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
  return path.join(pkg, sub) + path.sep;
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

export interface RenderedPage {
  png: Buffer;
  width: number;
  height: number;
  inkRatio: number; // fraction of non-white pixels (blank detection)
}

/** Render one page to PNG (longest side ≈ maxDim px) using pdf.js + @napi-rs/canvas. */
export async function renderPage(buf: Buffer, pageNo: number, maxDim = 2000): Promise<RenderedPage> {
  await getPdfJs();
  const { createCanvas } = require_("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const doc = await openDoc(buf);
  try {
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxDim / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const width = Math.ceil(vp.width);
    const height = Math.ceil(vp.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: vp,
    }).promise;
    const data = ctx.getImageData(0, 0, width, height).data;
    let ink = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += 4 * 7) {
      sampled++;
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
    }
    const png = Buffer.from(await canvas.encode("png"));
    page.cleanup();
    return { png, width, height, inkRatio: sampled ? ink / sampled : 0 };
  } finally {
    await doc.destroy();
  }
}

/** Fallback when rasterising fails: a single-page PDF Claude can read natively. */
export async function singlePagePdf(buf: Buffer, pageNo: number): Promise<Buffer> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [pageNo - 1]);
  out.addPage(p);
  return Buffer.from(await out.save());
}
