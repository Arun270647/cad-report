"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Table, Td, Th } from "@/components/ui";
import { LineChip, StatusBadge } from "@/components/job-status";
import { api } from "@/lib/fetcher";
import { cn, fmtMoney, fmtPct } from "@/lib/utils";
import { groupByMake } from "@/lib/bom/grouping";
import type { Anomaly, BomLine, DeviceCounts, PageRecord, PriceOption } from "@/lib/bom/types";
import type { ValidationResult } from "@/lib/bom/validation";

interface JobData {
  job: {
    id: string;
    filename: string;
    status: string;
    pageCount: number;
    pagesDone: number;
    pages: PageRecord[];
    anomalies: Anomaly[];
    counts: Partial<DeviceCounts>;
    error: string | null;
    margin: number;
    changesReport: null | {
      fromJobId: string;
      priceFileVersion: number;
      oldTotal: number;
      newTotal: number;
      changes: { position: number; description: string | null; mpn: string | null; oldPrice: number | null; newPrice: number | null; oldDisc: number | null; newDisc: number | null; change: string }[];
    };
  };
  lines: BomLine[];
  validation: ValidationResult;
  priceFile: { version: number; filename: string } | null;
}

type EditLine = BomLine & { uid: string; resolveConflict?: boolean };
const RUNNING = ["uploading", "analyzing", "extracting", "matching"];
let uidSeq = 0;
const withUid = (l: BomLine): EditLine => ({ ...l, uid: `l${++uidSeq}` });

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<JobData | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const running = useRef(false);

  const applyData = useCallback((d: JobData) => {
    setData(d);
    setLines(d.lines.map(withUid));
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    try {
      applyData(await api<JobData>(`/api/jobs/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, applyData]);

  useEffect(() => {
    load();
  }, [load]);

  // Drive the server-side pipeline one step at a time.
  const runSteps = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setRetryIn(null);
    try {
      for (let i = 0; i < 500; i++) {
        const r = await api<{ job: JobData["job"] }>(`/api/jobs/${id}/step`, { method: "POST" });
        setData((prev) => (prev ? { ...prev, job: { ...prev.job, ...r.job } } : prev));
        if (!RUNNING.includes(r.job.status)) break;
      }
      await load();
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.message);
      if (err.status === 503) setRetryIn(30);
    } finally {
      running.current = false;
    }
  }, [id, load]);

  useEffect(() => {
    if (data && RUNNING.includes(data.job.status) && !running.current && retryIn === null) runSteps();
  }, [data, runSteps, retryIn]);

  useEffect(() => {
    if (retryIn === null) return;
    if (retryIn <= 0) {
      setRetryIn(null);
      return;
    }
    const t = setTimeout(() => setRetryIn((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  const grouped = useMemo(() => groupByMake(lines), [lines]);

  function update(uid: string, patch: Partial<EditLine>) {
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
    setDirty(true);
  }
  function chooseOption(l: EditLine, idx: number) {
    const o: PriceOption = l.alternatives[idx];
    update(l.uid, {
      terexPn: o.terexPn,
      mpn: o.mpn,
      make: o.make,
      description: o.description ?? l.description,
      uom: o.uom ?? l.uom,
      listPrice: o.listPrice,
      disc: o.disc,
      resolveConflict: true,
      status: l.flags.includes("anomaly") ? "anomaly" : "matched",
    });
  }
  function addLine() {
    const pos = Math.max(0, ...lines.map((l) => l.position)) + 1;
    setLines((ls) => [
      ...ls,
      withUid({
        position: pos, terexPn: null, whereUsed: null, drgSheetNo: null, description: "", mpn: null, make: "", uom: "NOS", qty: 1,
        listPrice: null, disc: 0, margin: data?.job.margin ?? 0.125, status: "manual", flags: ["manual"], alternatives: [], notes: null, sourceKey: null, sourceCount: null,
      }),
    ]);
    setDirty(true);
  }
  function removeLine(uid: string) {
    setLines((ls) => ls.filter((l) => l.uid !== uid));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = lines
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          id: l.id, position: l.position, terexPn: l.terexPn, whereUsed: l.whereUsed, drgSheetNo: l.drgSheetNo, description: l.description,
          mpn: l.mpn, make: l.make, uom: l.uom, qty: Number(l.qty) || 0, listPrice: l.listPrice, disc: l.disc, margin: l.margin, notes: l.notes,
          resolveConflict: l.resolveConflict,
        }));
      applyData(await api<JobData>(`/api/jobs/${id}`, { method: "PATCH", json: { action: "save", lines: payload } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      applyData(await api<JobData>(`/api/jobs/${id}`, { method: "PATCH", json: { action: "approve", acknowledgeQuantityMismatch: ack } }));
    } catch (e) {
      const err = e as Error & { data?: { validation?: ValidationResult } };
      if (err.data?.validation) setData((d) => (d ? { ...d, validation: err.data!.validation! } : d));
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function reprice() {
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/api/jobs/${id}/reprice`, { method: "POST" });
      router.push(`/jobs/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="text-muted-foreground">{error ? <Alert variant="danger">{error}</Alert> : "Loading…"}</div>;
  const { job, validation } = data;
  const isRunning = RUNNING.includes(job.status);
  const stageIdx = { uploading: 0, analyzing: 0, extracting: 1, matching: 2, review: 3, approved: 3, failed: -1 }[job.status] ?? 0;
  const conflicts = lines.filter((l) => l.status === "conflict").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{job.filename}</h1>
          <p className="text-sm text-muted-foreground">
            <StatusBadge status={job.status} /> {data.priceFile && <> · Price file v{data.priceFile.version} ({data.priceFile.filename})</>} · Margin {fmtPct(job.margin)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(job.status === "review" || job.status === "approved") && (
            <Button variant="outline" onClick={reprice} disabled={busy}>
              Re-price with latest price file
            </Button>
          )}
          {job.status === "approved" && !dirty && (
            <a href={`/api/jobs/${id}/export`}>
              <Button>Export Excel</Button>
            </a>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="danger">
          {error}
          {retryIn !== null && <span> — retrying in {retryIn}s</span>}
          {isRunning && retryIn === null && !running.current && (
            <Button size="sm" variant="outline" className="ml-3" onClick={runSteps}>
              Retry now
            </Button>
          )}
        </Alert>
      )}
      {job.status === "failed" && <Alert variant="danger">Conversion failed: {job.error}</Alert>}

      {(isRunning || job.status === "failed") && (
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {["Rendering pages", "Extracting (per sheet)", "Matching", "Ready for review"].map((s, i) => (
                <div key={s} className={cn("rounded-md border p-3 text-center text-sm", i < stageIdx ? "border-emerald-300 bg-emerald-50" : i === stageIdx ? "border-sky-300 bg-sky-50 font-medium" : "border-border text-muted-foreground")}>
                  {s}
                  {i === 1 && job.pageCount > 0 && <div className="text-xs">{job.pagesDone}/{job.pageCount} sheets</div>}
                </div>
              ))}
            </div>
            {job.pageCount > 0 && (
              <div className="h-2 w-full overflow-hidden rounded bg-muted">
                <div className="h-full bg-sky-500 transition-all" style={{ width: `${(job.pagesDone / job.pageCount) * 100}%` }} />
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {job.pages.map((p) => (
                <Badge key={p.page} variant={p.status === "done" ? "success" : p.status === "skipped" ? "default" : p.status === "error" ? "danger" : "info"} title={p.skipReason ?? p.error ?? ""}>
                  p{p.page}
                  {p.status === "skipped" ? " skipped" : p.status === "error" ? " error" : p.status === "pending" ? "…" : ""}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(job.status === "review" || job.status === "approved") && (
        <>
          {job.changesReport && (
            <Card>
              <CardHeader>
                <CardTitle>Changes report (re-priced against price file v{job.changesReport.priceFileVersion})</CardTitle>
                <CardDescription>
                  Previous total {fmtMoney(job.changesReport.oldTotal)} → new total {fmtMoney(job.changesReport.newTotal)} (
                  {fmtMoney(job.changesReport.newTotal - job.changesReport.oldTotal)})
                </CardDescription>
              </CardHeader>
              <CardContent>
                {job.changesReport.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No price changes.</p>
                ) : (
                  <Table>
                    <thead><tr><Th>#</Th><Th>Description</Th><Th>P/N</Th><Th>Old list</Th><Th>New list</Th><Th>Old disc</Th><Th>New disc</Th><Th>Change</Th></tr></thead>
                    <tbody>
                      {job.changesReport.changes.map((c, i) => (
                        <tr key={i}><Td>{c.position}</Td><Td>{c.description}</Td><Td>{c.mpn}</Td><Td>{fmtMoney(c.oldPrice)}</Td><Td>{fmtMoney(c.newPrice)}</Td><Td>{fmtPct(c.oldDisc)}</Td><Td>{fmtPct(c.newDisc)}</Td><Td>{c.change}</Td></tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle>Device counts</CardTitle><CardDescription>Total extracted devices: {job.counts.totalDevices ?? 0}</CardDescription></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <CountList title="Pilot lamps by colour" rec={job.counts.pilotLampsByColour} />
                <CountList title="Pushbuttons by function" rec={job.counts.pushbuttonsByFunction} />
                <CountList title="Relays by type" rec={job.counts.relaysByType} />
                <CountList title="Terminals per block" rec={job.counts.terminalsPerBlock} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Drawing anomalies</CardTitle></CardHeader>
              <CardContent>
                {job.anomalies.length === 0 ? <p className="text-sm text-muted-foreground">None detected.</p> : (
                  <ul className="space-y-1 text-sm">
                    {job.anomalies.map((a, i) => (
                      <li key={i}><Badge variant="purple">{a.type.replace(/_/g, " ")}</Badge> {a.message} {a.sheets.length > 0 && <span className="text-muted-foreground">(sheet {a.sheets.join(", ")})</span>}</li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Summary by make</CardTitle><CardDescription>Grand total {fmtMoney(grouped.grandTotal)}</CardDescription></CardHeader>
              <CardContent>
                <Table>
                  <thead><tr><Th>Make</Th><Th>Lines</Th><Th className="text-right">Subtotal</Th><Th className="text-right">%</Th></tr></thead>
                  <tbody>
                    {grouped.summary.map((s) => (<tr key={s.make}><Td>{s.make}</Td><Td>{s.lineCount}</Td><Td className="text-right">{fmtMoney(s.subtotal)}</Td><Td className="text-right">{fmtPct(s.pct)}</Td></tr>))}
                    <tr className="font-semibold"><Td>Total</Td><Td>{lines.length}</Td><Td className="text-right">{fmtMoney(grouped.grandTotal)}</Td><Td className="text-right">{grouped.grandTotal > 0 ? "100.0%" : ""}</Td></tr>
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Review BOM (grouped by make)</CardTitle>
                <CardDescription>Edit cells, choose between conflicting price rows, add or remove lines, then save and approve.</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={addLine}>Add line</Button>
                <Button onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : dirty ? "Save changes" : "Saved"}</Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table className="text-xs">
                <thead>
                  <tr>
                    <Th>Status</Th><Th>Terex P/N</Th><Th>Where used</Th><Th>Sheet</Th><Th className="min-w-56">Description</Th><Th>Mfr P/N</Th><Th>Make</Th><Th>UOM</Th>
                    <Th>Qty</Th><Th>List price</Th><Th>Disc %</Th><Th className="text-right">Unit price</Th><Th>Margin %</Th><Th className="text-right">Terex unit</Th><Th className="text-right">Total</Th><Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.groups.map((g) => (
                    <GroupRows key={g.make} make={g.make} subtotal={g.subtotal}>
                      {g.lines.map((cl) => {
                        const uid = (cl as unknown as EditLine).uid;
                        const l = lines.find((x) => x.uid === uid)!;
                        return (
                          <tr key={l.uid} className={cn(l.status === "conflict" && "bg-red-50/60")}>
                            <Td>
                              <div className="flex flex-col gap-1">
                                <LineChip status={l.status} />
                                {l.flags.includes("anomaly") && l.status !== "anomaly" && <LineChip status="anomaly" />}
                              </div>
                            </Td>
                            <Td><Cell value={l.terexPn} onChange={(v) => update(l.uid, { terexPn: v })} w="w-24" /></Td>
                            <Td><Cell value={l.whereUsed} onChange={(v) => update(l.uid, { whereUsed: v })} w="w-28" /></Td>
                            <Td><Cell value={l.drgSheetNo} onChange={(v) => update(l.uid, { drgSheetNo: v })} w="w-14" /></Td>
                            <Td>
                              <Cell value={l.description} onChange={(v) => update(l.uid, { description: v })} w="w-full min-w-56" />
                              {l.alternatives.length > 1 && (
                                <Select className="mt-1 h-7 w-full text-xs" value="" onChange={(e) => e.target.value !== "" && chooseOption(l, Number(e.target.value))}>
                                  <option value="">{l.status === "conflict" ? "⚠ Choose price row…" : "Alternatives…"}</option>
                                  {l.alternatives.map((o, i) => (
                                    <option key={i} value={i}>
                                      {o.terexPn ? `[${o.terexPn}] ` : ""}{o.mpn} · {o.make} · list {fmtMoney(o.listPrice)} · disc {fmtPct(o.disc)} (row {o.rowNumber})
                                    </option>
                                  ))}
                                </Select>
                              )}
                              {l.notes && <p className="mt-1 whitespace-pre-line text-[11px] text-muted-foreground">{l.notes}</p>}
                            </Td>
                            <Td><Cell value={l.mpn} onChange={(v) => update(l.uid, { mpn: v })} w="w-24" /></Td>
                            <Td><Cell value={l.make} onChange={(v) => update(l.uid, { make: v })} w="w-24" invalid={!l.make} /></Td>
                            <Td><Cell value={l.uom} onChange={(v) => update(l.uid, { uom: v })} w="w-14" invalid={!l.uom} /></Td>
                            <Td><NumCell value={l.qty} onChange={(v) => update(l.uid, { qty: v ?? 0 })} w="w-14" /></Td>
                            <Td><NumCell value={l.listPrice} onChange={(v) => update(l.uid, { listPrice: v })} w="w-24" highlight={l.listPrice == null} /></Td>
                            <Td><NumCell value={l.disc == null ? null : +(l.disc * 100).toFixed(4)} onChange={(v) => update(l.uid, { disc: v == null ? null : v / 100 })} w="w-14" /></Td>
                            <Td className={cn("text-right", cl.unitPrice == null && "bg-yellow-100")}>{fmtMoney(cl.unitPrice)}</Td>
                            <Td><NumCell value={+(l.margin * 100).toFixed(4)} onChange={(v) => update(l.uid, { margin: (v ?? 0) / 100 })} w="w-14" /></Td>
                            <Td className={cn("text-right", cl.terexUnitPrice == null && "bg-yellow-100")}>{fmtMoney(cl.terexUnitPrice)}</Td>
                            <Td className="text-right font-medium">{fmtMoney(cl.totalPrice)}</Td>
                            <Td><Button variant="ghost" size="icon" title="Remove line" onClick={() => removeLine(l.uid)}>✕</Button></Td>
                          </tr>
                        );
                      })}
                    </GroupRows>
                  ))}
                  <tr className="bg-yellow-100 font-semibold">
                    <Td colSpan={14} className="text-right">GRAND TOTAL</Td>
                    <Td className="text-right">{fmtMoney(grouped.grandTotal)}</Td>
                    <Td />
                  </tr>
                </tbody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Validation & approval</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {dirty && <Alert variant="warning">You have unsaved changes. Save before approving.</Alert>}
              {conflicts > 0 && <Alert variant="danger">{conflicts} conflict line(s) must be resolved before export.</Alert>}
              {validation.errors.length > 0 && (
                <Alert variant="danger">
                  <ul className="list-disc pl-4">{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Alert>
              )}
              {validation.warnings.length > 0 && (
                <Alert variant="warning">
                  <ul className="list-disc pl-4">{validation.warnings.slice(0, 30).map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Alert>
              )}
              {validation.ok && !dirty && <Alert variant="success">All checks pass: grand total = sum of subtotals, no formula errors, MAKE/UOM present, quantities match, no conflicts.</Alert>}
              {validation.quantityMismatch && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I confirm the quantity differences are intentional
                </label>
              )}
              <div className="flex gap-2">
                <Button onClick={approve} disabled={busy || dirty || job.status === "approved"}>{job.status === "approved" ? "Approved" : "Approve BOM"}</Button>
                {job.status === "approved" && !dirty && (
                  <a href={`/api/jobs/${id}/export`}><Button variant="outline">Export Excel</Button></a>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function GroupRows({ make, subtotal, children }: { make: string; subtotal: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="bg-blue-50"><Td colSpan={16} className="font-semibold">{make}</Td></tr>
      {children}
      <tr className="bg-slate-50 font-semibold"><Td colSpan={14} className="text-right">SUBTOTAL – {make}</Td><Td className="text-right">{fmtMoney(subtotal)}</Td><Td /></tr>
    </>
  );
}

function Cell({ value, onChange, w, invalid }: { value: string | null; onChange: (v: string | null) => void; w?: string; invalid?: boolean }) {
  return <Input className={cn("h-7 px-1.5 text-xs", w, invalid && "border-red-400 bg-red-50")} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />;
}

function NumCell({ value, onChange, w, highlight }: { value: number | null; onChange: (v: number | null) => void; w?: string; highlight?: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  return (
    <Input
      className={cn("h-7 px-1.5 text-right text-xs", w, highlight && "bg-yellow-100")}
      value={text}
      inputMode="decimal"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(numOrNull(text))}
    />
  );
}

function CountList({ title, rec }: { title: string; rec?: Record<string, number> }) {
  const entries = Object.entries(rec ?? {});
  return (
    <div>
      <p className="font-medium">{title}</p>
      {entries.length === 0 ? <p className="text-muted-foreground">—</p> : (
        <p className="text-muted-foreground">{entries.map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
      )}
    </div>
  );
}
