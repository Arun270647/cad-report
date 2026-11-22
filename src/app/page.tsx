"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Table, Td, Th } from "@/components/ui";
import { LineChip, SheetBadge } from "@/components/job-status";
import { StatusPill } from "@/components/status-pill";
import { cn, fmtMoney, fmtPct } from "@/lib/utils";
import {
  apiRequest,
  AuthError,
  getActiveJob,
  isAbortError,
  resumeConversion,
  runConversion,
  setActiveJob,
  type ConversionProgress,
} from "@/lib/client/convert";
import { parsePriceFile } from "@/lib/bom/pricefile";
import { aggregate } from "@/lib/bom/aggregate";
import { matchAll } from "@/lib/bom/matching";
import { buildWorkbook } from "@/lib/bom/excel";
import { type GroupedBom } from "@/lib/bom/grouping";
import { validateBom, type ValidationResult } from "@/lib/bom/validation";
import type { Anomaly, BomLine, DeviceCounts, PageRecord } from "@/lib/bom/types";
import type { StatusView } from "@/lib/contract";

const LS_PRICE = "pbp.priceFile";
const LS_MARGIN = "pbp.margin";
const STATUS_POLL_MS = 15000;

type Phase = "idle" | "preparing" | "uploading" | "waiting" | "matching" | "done";

interface Result {
  lines: BomLine[];
  grouped: GroupedBom;
  counts: DeviceCounts;
  anomalies: Anomaly[];
  validation: ValidationResult;
  url: string;
  filename: string;
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
  const [progress, setProgress] = useState<ConversionProgress | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [held, setHeld] = useState<{ records: PageRecord[]; filename: string } | null>(null); // finished job waiting for a price list
  const [email, setEmail] = useState<string | null>(null);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [resumed, setResumed] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const priceInput = useRef<HTMLInputElement>(null);
  const runRef = useRef<AbortController | null>(null);
  const progressName = useRef("");
  const priceRef = useRef(price);
  const marginRef = useRef(margin);
  priceRef.current = price;
  marginRef.current = margin;

  /* Build the BOM + Excel locally (price list never leaves the browser). */
  const finish = useCallback(async (records: PageRecord[], drawingName: string) => {
    const pf = priceRef.current;
    if (!pf) {
      setHeld({ records, filename: drawingName });
      setPhase("idle");
      return;
    }
    setHeld(null);
    setPhase("matching");
    try {
      const marginFrac = Math.max(0, Number(marginRef.current) || 0) / 100;
      store.set(LS_MARGIN, marginRef.current);
      const { rows, rules } = await parsePriceFile(pf.data.slice(0));
      const { groups, counts, anomalies } = aggregate(records);
      for (const p of records.filter((x) => x.status === "error")) {
        anomalies.push({ type: "unreadable_sheet", message: `Page ${p.page}: ${p.error}`, tags: [], sheets: [String(p.page)] });
      }
      const lines = matchAll(groups, { rules, items: rows, margin: marginFrac });
      const title = drawingName || "Drawing";
      const { buffer, grouped } = await buildWorkbook(lines, { title });
      const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const filename = title.replace(/\.pdf$/i, "") + "_BOM.xlsx";
      setResult((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { lines, grouped, counts, anomalies, validation: validateBom(lines, counts), url, filename };
      });
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }, []);

  /** Run (or resume) a conversion; only the latest run may update state. */
  const start = useCallback(
    async (work: (signal: AbortSignal) => Promise<PageRecord[]>, fallbackName: string) => {
      runRef.current?.abort();
      const ctrl = new AbortController();
      runRef.current = ctrl;
      setError(null);
      setResult(null);
      setHeld(null);
      setPhase("preparing");
      try {
        const records = await work(ctrl.signal);
        if (runRef.current !== ctrl) return;
        await finish(records, progressName.current || fallbackName);
      } catch (e) {
        if (runRef.current !== ctrl || isAbortError(e) || e instanceof AuthError) return;
        setError((e as Error).message);
        setPhase("idle");
      }
    },
    [finish],
  );
  const onProgress = useCallback((p: ConversionProgress) => {
    if (p.filename) progressName.current = p.filename;
    setProgress((old) => (p.pages.length === 0 && old && old.jobId === p.jobId ? { ...old, connectionIssue: p.connectionIssue } : p));
    if (p.phase !== "done") setPhase(p.phase);
  }, []);

  /* Restore remembered price list + margin; resume a running job. */
  useEffect(() => {
    const saved = store.get(LS_PRICE);
    if (saved) {
      try {
        const { name, b64 } = JSON.parse(saved) as { name: string; b64: string };
        const p = { name, data: b64ToBuf(b64) };
        priceRef.current = p;
        setPrice(p);
      } catch {
        /* ignore */
      }
    }
    const m = store.get(LS_MARGIN);
    if (m) {
      marginRef.current = m;
      setMargin(m);
    }
    const active = getActiveJob();
    if (active) {
      setResumed(true);
      progressName.current = active.filename;
      void start((signal) => resumeConversion(active.id, onProgress, signal), active.filename);
    }
    return () => runRef.current?.abort();
  }, [start, onProgress]);

  /* Signed-in email. */
  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<{ email?: unknown }>("/api/session", { signal: ctrl.signal })
      .then((s) => setEmail(typeof s?.email === "string" ? s.email : null))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  /* Worker status pill (every 15 s). */
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await apiRequest<StatusView>("/api/status", { signal: ctrl.signal });
        setWorkerOnline(!!s?.workerOnline);
      } catch (e) {
        if (isAbortError(e) || e instanceof AuthError) return;
        setWorkerOnline(null);
      }
      if (!ctrl.signal.aborted) timer = setTimeout(tick, STATUS_POLL_MS);
    };
    void tick();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);

  /* A finished job was waiting for the price list. */
  useEffect(() => {
    if (held && price) void finish(held.records, held.filename);
  }, [held, price, finish]);

  async function signOut() {
    runRef.current?.abort();
    try {
      await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
    } catch {
      /* cookie may already be gone — go to /login anyway */
    }
    window.location.replace("/login");
  }

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
    if (!store.set(LS_PRICE, JSON.stringify({ name: f.name, b64: bufToB64(data) }))) {
      setError("The price list is loaded, but this browser could not remember it (storage full or disabled).");
    }
  }
  function pickPdf(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) return setError("The drawing must be a PDF file.");
    if (f.size > 50 * 1024 * 1024) return setError("The PDF is larger than 50 MB.");
    setError(null);
    setPdf(f);
    setResult(null);
    setProgress(null);
    setPhase("idle");
  }

  function convert() {
    if (!pdf || !price) return;
    const file = pdf;
    setResumed(false);
    setProgress(null);
    progressName.current = file.name;
    store.set(LS_MARGIN, margin);
    void start(async (signal) => runConversion(await file.arrayBuffer(), file.name, onProgress, signal), file.name);
  }

  function stopWatching() {
    runRef.current?.abort();
    runRef.current = null;
    setActiveJob(null);
    setProgress(null);
    setResumed(false);
    setPhase("idle");
  }

  const busy = phase === "preparing" || phase === "uploading" || phase === "waiting" || phase === "matching";
  const pages = progress?.pages ?? [];
  const finishedCount = pages.filter((p) => p.status !== "pending").length;
  const readingCount = pages.filter((p) => p.stage === "reading").length;
  const queuedCount = pages.filter((p) => p.stage === "queued").length;
  const uploadedCount = pages.filter((p) => p.status === "pending" && p.stage !== "uploading" && p.stage !== "rendering").length + finishedCount;
  const showQueue = phase === "waiting" && readingCount === 0 && queuedCount > 0 && progress != null;

  const buttonLabel =
    phase === "preparing"
      ? `Preparing sheets… ${finishedCount + pages.filter((p) => p.stage === "uploading").length}/${pages.length || "?"}`
      : phase === "uploading"
        ? `Uploading sheets… ${uploadedCount}/${pages.length}`
        : phase === "waiting"
          ? `Reading sheets on PC… ${finishedCount}/${pages.length || "?"}`
          : phase === "matching"
            ? "Matching & building Excel…"
            : "Convert to Excel";

  return (
    <div className="min-h-screen">
      <div className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <span className="font-semibold">⚡ Panel BOM Pricer</span>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            {email && <span className="truncate text-muted-foreground" title={email}>{email}</span>}
            <Button size="sm" variant="outline" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-sm text-muted-foreground">Drop a control-panel drawing PDF and get a priced BOM in Excel, grouped by make.</p>
          <StatusPill online={workerOnline} />
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          <DropZone
            className="md:col-span-2"
            title={pdf ? pdf.name : resumed && progress?.filename ? progress.filename : "Drop the drawing PDF here"}
            subtitle={pdf ? `${(pdf.size / 1024 / 1024).toFixed(2)} MB — click to change` : resumed && busy ? "Resumed after reload — still processing" : "or click to choose a PDF"}
            active={!!pdf || (resumed && busy)}
            onFile={(f) => !busy && pickPdf(f)}
            onClick={() => !busy && pdfInput.current?.click()}
          >
            <input ref={pdfInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pickPdf(e.target.files?.[0])} />
          </DropZone>
          <DropZone
            title={price ? price.name : "Drop your price list (.xlsx)"}
            subtitle={price ? "Remembered in this browser — click to replace" : "Needed once; remembered afterwards. It never leaves this browser."}
            active={!!price}
            onFile={pickPrice}
            onClick={() => priceInput.current?.click()}
          >
            <input ref={priceInput} type="file" accept=".xlsx" className="hidden" onChange={(e) => pickPrice(e.target.files?.[0])} />
          </DropZone>
        </div>

        <div className="flex flex-wrap items-end gap-3 sm:gap-4">
          <div className="space-y-1">
            <Label htmlFor="margin">Margin %</Label>
            <Input id="margin" type="number" step="0.1" min="0" className="w-28" value={margin} onChange={(e) => setMargin(e.target.value)} />
          </div>
          <Button size="lg" onClick={convert} disabled={!pdf || !price || busy}>
            {buttonLabel}
          </Button>
          {result && (
            <a href={result.url} download={result.filename} className="max-w-full">
              <Button size="lg" variant="outline" className="max-w-full">
                <span className="truncate">⬇ Download {result.filename}</span>
              </Button>
            </a>
          )}
          {(phase === "waiting" || phase === "uploading") && (
            <Button size="sm" variant="ghost" onClick={stopWatching} title="Stop following this job in this browser">
              Stop
            </Button>
          )}
        </div>

        {error && <Alert variant="danger">{error}</Alert>}
        {held && !price && (
          <Alert variant="warning">
            All sheets of {held.filename || "the drawing"} have been read. Drop your price list above to build the Excel file.
          </Alert>
        )}

        {progress && (pages.length > 0 || busy) && (
          <Card>
            <CardContent className="space-y-3 pt-5">
              {showQueue && (
                <p className="text-sm font-medium">
                  Position in queue: {progress.queuePosition + 1}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {progress.queuePosition === 0 ? "— your sheets are next" : `— ${progress.queuePosition} sheet${progress.queuePosition === 1 ? "" : "s"} from earlier jobs ahead`}
                  </span>
                </p>
              )}
              {phase === "waiting" && workerOnline === false && (
                <p className="text-sm text-amber-800">The PC worker is offline. Your sheets are safely queued and will be read when it is back — you can close this tab and return later.</p>
              )}
              {progress.connectionIssue && <p className="text-sm text-amber-800">Connection problem — retrying…</p>}
              {pages.length > 0 && (
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full bg-sky-500 transition-all" style={{ width: `${(finishedCount / pages.length) * 100}%` }} />
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {pages.map((p) => (
                  <SheetBadge key={p.page} p={p} />
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
    </div>
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
