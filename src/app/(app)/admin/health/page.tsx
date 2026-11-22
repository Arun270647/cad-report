"use client";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtDate, fmtMoney } from "@/lib/utils";

interface Health {
  status: string; reason: string;
  lastCheck: { at: string; success: boolean; latencyMs: number; model: string } | null;
  lastHour: { requests: number; errorRate: number; avgLatency: number };
  series: { bucket: string; requests: number; success: number; errors: number; avgLatency: number; tokensIn: number; tokensOut: number; cost: number }[];
  totals: { requests: number; errors: number; cost: number; tokensIn: number; tokensOut: number };
  errors: { id: number; createdAt: string; email: string | null; jobId: string | null; kind: string; errorType: string | null; statusCode: number | null; message: string | null }[];
  budget: { spendUsd: number; spendInBudgetCurrency: number; budget: number | null; currency: string; pct: number | null; level: number };
  conversionsEnabled: boolean;
}

const C = { blue: "#2563eb", green: "#16a34a", red: "#dc2626", amber: "#d97706", violet: "#7c3aed" };

export default function HealthPage() {
  const [range, setRange] = useState<"24h" | "7d" | "30d">("24h");
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Health>(`/api/admin/health?range=${range}`).then(setH).catch((e) => setError(e.message)), [range]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const statusVariant = h?.status === "Connected" ? "success" : h?.status === "Degraded" ? "warning" : "danger";
  const series = h?.series.map((s) => ({ ...s, label: range === "24h" ? s.bucket.slice(11, 16) : s.bucket.slice(5, 10), errorRate: s.requests ? +(100 * s.errors / s.requests).toFixed(1) : 0 })) ?? [];
  const cur = h?.budget.currency === "INR" ? "₹" : "$";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">API health</h1>
        <div className="flex gap-1">
          {(["24h", "7d", "30d"] as const).map((r) => <Button key={r} size="sm" variant={r === range ? "default" : "outline"} onClick={() => setRange(r)}>{r}</Button>)}
        </div>
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
      {h && h.budget.level >= 100 && <Alert variant="danger">Monthly budget reached ({Math.round((h.budget.pct ?? 0) * 100)}%). New conversions are blocked.</Alert>}
      {h && h.budget.level === 80 && <Alert variant="warning">Budget alert: {Math.round((h.budget.pct ?? 0) * 100)}% of the monthly cap used.</Alert>}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader><CardDescription>Live status</CardDescription><CardTitle><Badge variant={statusVariant} className="text-sm">{h?.status ?? "…"}</Badge></CardTitle></CardHeader>
          <CardContent className="text-xs text-muted-foreground">{h?.reason}<br />{h?.lastCheck && <>Last check {fmtDate(h.lastCheck.at)} · {h.lastCheck.latencyMs} ms</>}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardDescription>Requests ({range})</CardDescription><CardTitle>{h?.totals.requests ?? "–"}</CardTitle></CardHeader>
          <CardContent className="text-xs text-muted-foreground">{h ? `${h.totals.errors} errors · last hour ${(h.lastHour.errorRate * 100).toFixed(0)}% errors` : ""}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardDescription>Tokens in / out ({range})</CardDescription><CardTitle>{h ? `${h.totals.tokensIn.toLocaleString()} / ${h.totals.tokensOut.toLocaleString()}` : "–"}</CardTitle></CardHeader>
          <CardContent className="text-xs text-muted-foreground">Est. cost ${fmtMoney(h?.totals.cost ?? 0, 4)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardDescription>Month spend vs budget</CardDescription><CardTitle>{h ? `${cur}${fmtMoney(h.budget.spendInBudgetCurrency)}` : "–"}{h?.budget.budget ? ` / ${cur}${fmtMoney(h.budget.budget)}` : ""}</CardTitle></CardHeader>
          <CardContent>{h?.budget.pct != null && <div className="h-2 w-full overflow-hidden rounded bg-muted"><div className={`h-full ${h.budget.level >= 100 ? "bg-red-500" : h.budget.level >= 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, h.budget.pct * 100)}%` }} /></div>}</CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Requests: success vs error">
          <BarChart data={series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} allowDecimals={false} /><Tooltip /><Legend /><Bar dataKey="success" stackId="a" fill={C.green} name="Success" /><Bar dataKey="errors" stackId="a" fill={C.red} name="Error" /></BarChart>
        </ChartCard>
        <ChartCard title="Average latency (ms) & error rate (%)">
          <LineChart data={series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={11} /><YAxis yAxisId="l" fontSize={11} /><YAxis yAxisId="r" orientation="right" fontSize={11} /><Tooltip /><Legend /><Line yAxisId="l" dataKey="avgLatency" stroke={C.blue} name="Avg latency" dot={false} /><Line yAxisId="r" dataKey="errorRate" stroke={C.red} name="Error %" dot={false} /></LineChart>
        </ChartCard>
        <ChartCard title="Tokens in / out">
          <BarChart data={series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} /><Tooltip /><Legend /><Bar dataKey="tokensIn" fill={C.blue} name="Input" /><Bar dataKey="tokensOut" fill={C.violet} name="Output" /></BarChart>
        </ChartCard>
        <ChartCard title="Estimated cost (USD)">
          <BarChart data={series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} /><Tooltip formatter={(v) => `$${Number(v).toFixed(4)}`} /><Bar dataKey="cost" fill={C.amber} name="Cost" /></BarChart>
        </ChartCard>
      </div>
      <Card>
        <CardHeader><CardTitle>Rate-limit & error log</CardTitle></CardHeader>
        <CardContent>
          <Table className="text-xs">
            <thead><tr><Th>Time</Th><Th>User</Th><Th>Job</Th><Th>Kind</Th><Th>Error type</Th><Th>HTTP</Th><Th>Message</Th></tr></thead>
            <tbody>
              {h?.errors.map((e) => (
                <tr key={e.id}><Td className="whitespace-nowrap">{fmtDate(e.createdAt)}</Td><Td>{e.email ?? "system"}</Td><Td>{e.jobId ? <a className="text-sky-700 hover:underline" href={`/jobs/${e.jobId}`}>{e.jobId.slice(0, 8)}</a> : "—"}</Td><Td>{e.kind}</Td><Td><Badge variant="danger">{e.errorType}</Badge></Td><Td>{e.statusCode ?? ""}</Td><Td className="max-w-md truncate" title={e.message ?? ""}>{e.message}</Td></tr>
              ))}
              {h && h.errors.length === 0 && <tr><Td colSpan={7} className="text-center text-muted-foreground">No errors in this period.</Td></tr>}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="h-64"><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></CardContent>
    </Card>
  );
}
