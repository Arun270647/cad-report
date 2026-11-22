"use client";
/** Browser-side PDF handling: page text (RESERVED detection) and rendering to an image for Claude. */
type PdfJs = typeof import("pdfjs-dist");
let pdfjsP: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  if (!pdfjsP) {
    pdfjsP = import("pdfjs-dist").then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return m;
    });
  }
  return pdfjsP;
}

export type PdfDoc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

export async function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const lib = await pdfjs();
  return lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
}

export async function pageText(doc: PdfDoc, n: number): Promise<{ text: string; wordCount: number }> {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim();
  return { text, wordCount: text ? text.split(" ").length : 0 };
}

export function isReservedText(t: { text: string; wordCount: number }): boolean {
  return /\bRESERVED\b/i.test(t.text) && t.wordCount <= 40;
}

const MAX_B64 = 4_000_000; // stay under Vercel's 4.5 MB request limit

/** Render a page (longest side ≈ maxDim px). Returns base64 image + fraction of non-white pixels. */
export async function renderPage(doc: PdfDoc, n: number, maxDim = 2000): Promise<{ data: string; mediaType: "image/png" | "image/jpeg"; inkRatio: number }> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  let dim = maxDim;
  for (let tries = 0; tries < 4; tries++) {
    const scale = Math.min(4, dim / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0, sampled = 0;
    for (let i = 0; i < px.length; i += 4 * 7) {
      sampled++;
      if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) ink++;
    }
    const inkRatio = sampled ? ink / sampled : 0;
    let url = canvas.toDataURL("image/png");
    let mediaType: "image/png" | "image/jpeg" = "image/png";
    if (url.length > MAX_B64) {
      url = canvas.toDataURL("image/jpeg", 0.85);
      mediaType = "image/jpeg";
    }
    if (url.length <= MAX_B64) return { data: url.slice(url.indexOf(",") + 1), mediaType, inkRatio };
    dim = Math.round(dim * 0.75);
  }
  throw new Error(`Page ${n} is too large to send`);
}
