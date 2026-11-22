"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Table, Td, Th } from "@/components/ui";
import { LineChip } from "@/components/job-status";
import { cn, fmtMoney, fmtPct } from "@/lib/utils";
import { extractDrawing, PasscodeError, type PageProgress } from "@/lib/client/convert";
import { parsePriceFile } from "@/lib/bom/pricefile";
import { aggregate } from "@/lib/bom/aggregate";
import { matchAll } from "@/lib/bom/matching";
import { buildWorkbook } from "@/lib/bom/excel";
import { groupByMake, type GroupedBom } from "@/lib/bom/grouping";
import { validateBom, type ValidationResult } from "@/lib/bom/validation";
import type { Anomaly, BomLine, DeviceCounts } from "@/lib/bom/types";

const LS_PRICE = "pbp.priceFile";
const LS_MARGIN = "pbp.margin";
const LS_PASS = "pbp.passcode";

interface Result {
  lines: BomLine[];
  grouped: GroupedBom;
  counts: DeviceCounts;
  anomalies: Anomaly[];
  validation: ValidationResult;
  url: string;
  filename: string;
  tokens: { input: number; output: number };
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
};

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function Home() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [price, setPrice] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const [margin, setMargin] = useState("12.5");
  const [pages, setPages] = useState<PageProgress[]>([]);
  const [phase, setPhase] = useState<"idle" | "reading" | "matching" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [needPass, setNeedPass] = useState(false);
  const [pass, setPass] = useState("");
  const pdfInput = useRef<HTMLInputElement>(null);
  const priceInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = store.get(LS_PRICE);
    if (saved) {
      try {
        const { name, b64 } = JSON.parse(saved);
        setPrice({ name, data: b64ToBuf(b64) });
      } catch {
        /* ignore */
      }
    }
    const m = store.get(LS_MARGIN);
    if (m) setMargin(m);
  }, []);

  async function pickPrice(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".xlsx")) return setError("The price list must be an .xlsx file.");
    const data = await f.arrayBuffer();
    try {
      await parsePriceFile(data.slice(0));
    } catch (e) {
      return setError(`Price list: ${(e as Error).message}`);
    }
    setError(null);
    setPrice({ name: f.name, data });
    store.set(LS_PRICE, JSON.stringify({ name: f.name, b64: bufToB64(data) }));
  }
  function pickPdf(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) return setError("The drawing must be a PDF file.");
    if (f.size > 50 * 1024 * 1024) return setError("The PDF is larger than 50 MB.");
    setError(null);
    setPdf(f);
    setResult(null);
    setPages([]);
    setPhase("idle");
  }

  async function convert() {
    if (!pdf || !price) return;
    setError(null);
    setResult(null);
    setPhase("reading");
    try {
      const marginFrac = Math.max(0, Number(margin) || 0) / 100;
      store.set(LS_MARGIN, margin);
      const { rows, rules } = await parsePriceFile(price.data.slice(0));
      const { pages: done, tokens } = await extractDrawing(await pdf.arrayBuffer(), setPages, store.get(LS_PASS));
      setPhase("matching");
      const { groups, counts, anomalies } = aggregate(done);
      for (const p of done.filter((x) => x.status === "error")) {
        anomalies.push({ type: "unreadable_sheet", message: `Page ${p.page}: ${p.error}`, tags: [], sheets: [String(p.page)] });
      }
      const lines = matchAll(groups, { rules, items: rows, margin: marginFrac });
      const { buffer, grouped } = await buildWorkbook(lines, { title: pdf.name });
      const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const filename = pdf.name.replace(/\.pdf$/i, "") + "_BOM.xlsx";
      setResult({ lines, grouped, counts, anomalies, validation: validateBom(lines, counts), url, filename, tokens });
      setPhase("done");
    } catch (e) {
      if (e instanceof PasscodeError) {
        setNeedPass(true);
        setPhase("idle");
        return;
      }
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const busy = phase === "reading" || phase === "matching";
  const doneCount = pages.filter((p) => p.status !== "pending").length;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">⚡ Panel BOM Pricer</h1>
        <p className="text-sm text-muted-foreground">Drop a control-panel drawing PDF and get a priced BOM in Excel, grouped by make.</p>
      </header>

      {needPass && (
        <Card>
          <CardHeader>
            <CardTitle>Passcode</CardTitle>
            <CardDescription>This site is protected. Enter the passcode once and this browser will remember it.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} className="max-w-xs" />
            <Button
              onClick={() => {
                store.set(LS_PASS, pass);
                setNeedPass(false);
                convert();
              }}
            >
              Continue
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <DropZone
          className="md:col-span-2"
          title={pdf ? pdf.name : "Drop the drawing PDF here"}
          subtitle={pdf ? `${(pdf.size / 1024 / 1024).toFixed(2)} MB — click to change` : "or click to choose a PDF"}
          active={!!pdf}
          onFile={pickPdf}
          onClick={() => pdfInput.current?.click()}
        >
          <input ref={pdfInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pickPdf(e.target.files?.[0])} />
        </DropZone>
        <DropZone
          title={price ? price.name : "Drop your price list (.xlsx)"}
          subtitle={price ? "Remembered in this browser — click to replace" : "Needed once; remembered afterwards"}
          active={!!price}
          onFile={pickPrice}
          onClick={() => priceInput.current?.click()}
        >
          <input ref={priceInput} type="file" accept=".xlsx" className="hidden" onChange={(e) => pickPrice(e.target.files?.[0])} />
        </DropZone>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="margin">Margin %</Label>
          <Input id="margin" type="number" step="0.1" min="0" className="w-28" value={margin} onChange={(e) => setMargin(e.target.value)} />
        </div>
        <Button size="lg" onClick={convert} disabled={!pdf || !price || busy}>
          {phase === "reading" ? `Reading sheets… ${doneCount}/${pages.length || "?"}` : phase === "matching" ? "Matching & building Excel…" : "Convert to Excel"}
        </Button>
        {result && (
          <a href={result.url} download={result.filename}>
            <Button size="lg" variant="outline">⬇ Download {result.filename}</Button>
          </a>
        )}
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {pages.length > 0 && (
        <Card>
          <CardContent className="space-y-3 pt-5">
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${(doneCount / pages.length) * 100}%` }} />
            </div>
            <div className="flex flex-wrap gap-1">
              {pages.map((p) => (
                <Badge
                  key={p.page}
                  title={p.skipReason ?? p.error ?? ""}
                  variant={p.status === "done" ? "success" : p.status === "skipped" ? "default" : p.status === "error" ? "danger" : "info"}
                >
                  Sheet {p.page}:{" "}
                  {p.status === "done" ? "read" : p.status === "skipped" ? p.skipReason?.toLowerCase() : p.status === "error" ? "error" : p.stage === "reading" ? "reading…" : p.stage === "rendering" ? "rendering…" : "queued"}
                </Badge>
              ))}
            </div>
            {pages.some((p) => p.status === "error") && (
              <p className="text-xs text-red-700">{pages.filter((p) => p.status === "error").map((p) => `Sheet ${p.page}: ${p.error}`).join(" · ")}</p>
            )}
          </CardContent>
        </Card>
      )}

      {result && <ResultView r={result} />}
    </main>
  );
}

function DropZone(props: { title: string; subtitle: string; active: boolean; onFile: (f: File | undefined) => void; onClick: () => void; className?: string; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn(
        "flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
        over ? "border-sky-500 bg-sky-50" : props.active ? "border-emerald-400 bg-emerald-50/50" : "border-border bg-white hover:bg-muted",
        props.className,
      )}
      onClick={props.onClick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        props.onFile(e.dataTransfer.files?.[0]);
      }}
    >
      <p className="font-medium break-all">{props.title}</p>
      <p className="text-xs text-muted-foreground">{props.subtitle}</p>
      {props.children}
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const c = r.counts;
  const list = (rec: Record<string, number>) => (Object.keys(rec).length ? Object.entries(rec).map(([k, v]) => `${k}: ${v}`).join(" · ") : "—");
  const flagged = r.lines.filter((l) => l.status !== "matched").length;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Summary by make</CardTitle>
            <CardDescription>
              Grand total {fmtMoney(r.grouped.grandTotal)} · {r.lines.length} lines · {flagged} need attention
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="text-sm">
              <thead>
                <tr><Th>Make</Th><Th>Lines</Th><Th className="text-right">Subtotal</Th><Th className="text-right">%</Th></tr>
              </thead>
              <tbody>
                {r.grouped.summary.map((s) => (
                  <tr key={s.make}><Td>{s.make}</Td><Td>{s.lineCount}</Td><Td className="text-right">{fmtMoney(s.subtotal)}</Td><Td className="text-right">{fmtPct(s.pct)}</Td></tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Device counts</CardTitle><CardDescription>{c.totalDevices} devices extracted</CardDescription></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><b>Pilot lamps:</b> {list(c.pilotLampsByColour)}</p>
            <p><b>Pushbuttons:</b> {list(c.pushbuttonsByFunction)}</p>
            <p><b>Relays:</b> {list(c.relaysByType)}</p>
            <p><b>Terminals:</b> {list(c.terminalsPerBlock)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Checks</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {r.anomalies.length === 0 && r.validation.errors.length === 0 ? (
              <p className="text-emerald-700">No drawing anomalies; all totals consistent.</p>
            ) : null}
            {r.anomalies.map((a, i) => (
              <p key={i}><Badge variant="purple">{a.type.replace(/_/g, " ")}</Badge> {a.message}</p>
            ))}
            {r.validation.errors.map((e, i) => (
              <p key={`e${i}`} className="text-amber-800">
                ⚠ {e.replace(" — acknowledge to continue", "").replace("unresolved price conflict", "price conflict — used the Terex P/N row; alternatives are in the Excel comment").replace("MAKE is missing", "not in price list, so MAKE is blank")}
              </p>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">Claude tokens used: {r.tokens.input.toLocaleString()} in / {r.tokens.output.toLocaleString()} out</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>BOM preview</CardTitle>
          <CardDescription>Exactly what is in the Excel file. Yellow = not in price list (price left blank, never substituted). Conflicts use the row with a Terex P/N; alternatives are listed in the cell comment.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table className="text-xs">
            <thead>
              <tr><Th>Status</Th><Th>Terex P/N</Th><Th>Where used</Th><Th>Description</Th><Th>Mfr P/N</Th><Th>UOM</Th><Th className="text-right">Qty</Th><Th className="text-right">List</Th><Th className="text-right">Disc</Th><Th className="text-right">Terex unit</Th><Th className="text-right">Total</Th></tr>
            </thead>
            <tbody>
              {r.grouped.groups.map((g) => (
                <GroupBlock key={g.make} g={g} />
              ))}
              <tr className="bg-yellow-100 font-semibold"><Td colSpan={10} className="text-right">GRAND TOTAL</Td><Td className="text-right">{fmtMoney(r.grouped.grandTotal)}</Td></tr>
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function GroupBlock({ g }: { g: GroupedBom["groups"][number] }) {
  return (
    <>
      <tr className="bg-blue-50"><Td colSpan={11} className="font-semibold">{g.make}</Td></tr>
      {g.lines.map((l) => (
        <tr key={l.position}>
          <Td><LineChip status={l.status} /></Td>
          <Td>{l.terexPn}</Td>
          <Td className="max-w-40 truncate" title={l.whereUsed ?? ""}>{l.whereUsed}</Td>
          <Td title={l.notes ?? ""}>{l.description}{l.notes && <span className="ml-1 text-muted-foreground">ⓘ</span>}</Td>
          <Td>{l.mpn}</Td>
          <Td>{l.uom}</Td>
          <Td className="text-right">{l.qty}</Td>
          <Td className={cn("text-right", l.listPrice == null && "bg-yellow-100")}>{fmtMoney(l.listPrice)}</Td>
          <Td className="text-right">{fmtPct(l.disc)}</Td>
          <Td className={cn("text-right", l.terexUnitPrice == null && "bg-yellow-100")}>{fmtMoney(l.terexUnitPrice)}</Td>
          <Td className="text-right">{fmtMoney(l.totalPrice)}</Td>
        </tr>
      ))}
      <tr className="bg-slate-50 font-semibold"><Td colSpan={10} className="text-right">SUBTOTAL – {g.make}</Td><Td className="text-right">{fmtMoney(g.subtotal)}</Td></tr>
    </>
  );
}
