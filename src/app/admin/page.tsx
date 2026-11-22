"use client";
import { useCallback, useEffect, useState } from "react";
import type { AdminWorkerView, JobStatus, WorkerState } from "@/lib/contract";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui";

const REFRESH_MS = 10_000;

const STATE: Record<WorkerState, { label: string; v: "success" | "warning" | "danger"; dot: string }> = {
  online: { label: "Online", v: "success", dot: "bg-emerald-500" },
  degraded: { label: "Degraded", v: "warning", dot: "bg-amber-500" },
  offline: { label: "Offline", v: "danger", dot: "bg-red-500" },
};

const JOB: Record<JobStatus, { label: string; v: "default" | "success" | "warning" | "info" | "purple" }> = {
  uploading: { label: "Uploading", v: "info" },
  queued: { label: "Queued", v: "default" },
  processing: { label: "Processing", v: "purple" },
  waiting_limit: { label: "Waiting – usage limit", v: "warning" },
  done: { label: "Done", v: "success" },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
function dur(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export default function AdminWorkerPage() {
  const [view, setView] = useState<AdminWorkerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/worker", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 403) {
        setError("This page is for admins only.");
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setView((await res.json()) as AdminWorkerView);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  async function setPaused(pause: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/worker", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: pause ? "pause" : "resume" }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const st = view ? STATE[view.state] : null;
  const openAlerts = view?.alerts.filter((a) => !a.resolvedAt) ?? [];
  const pastAlerts = view?.alerts.filter((a) => a.resolvedAt) ?? [];

  return (
    <div className="min-h-screen">
      <div className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <span className="font-semibold">⚡ Panel BOM Pricer — Admin</span>
          <a href="/" className="rounded-md px-2 py-1 text-sm font-medium text-sky-700 hover:bg-sky-50">
            ← Back to converter
          </a>
        </div>
      </div>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:py-8">
        <h1 className="text-xl font-semibold">Worker</h1>
        {error && <Alert variant="danger">{error}</Alert>}
        {!view && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {view && st && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="md:col-span-2">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2">
                    <span className={`h-3 w-3 rounded-full ${st.dot} ${view.state === "online" ? "animate-pulse" : ""}`} aria-hidden />
                    PC worker
                    <Badge variant={st.v} data-testid="worker-state">{st.label}</Badge>
                    {view.paused && <Badge variant="warning">Paused</Badge>}
                  </CardTitle>
                  <Button size="sm" variant={view.paused ? "default" : "outline"} disabled={busy} onClick={() => setPaused(!view.paused)}>
                    {view.paused ? "Resume conversions" : "Pause conversions"}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {view.reasons.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-amber-900">
                      {view.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {view.paused && (
                    <p className="text-amber-900">
                      Paused {view.pausedBy ? `by ${view.pausedBy} ` : ""}{view.pausedAt ? `at ${when(view.pausedAt)}` : ""}. The page being read finishes; nothing new is started.
                    </p>
                  )}
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Last heartbeat</dt><dd>{ago(view.lastSeen)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Last poll</dt><dd>{ago(view.lastPoll)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">PC</dt><dd>{view.host ?? "—"}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Worker started</dt><dd>{when(view.startedAt)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Node</dt><dd>{view.nodeVersion ?? "—"}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Claude Code</dt><dd>{view.claudeVersion ?? "—"}</dd></div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">claude.ai login</dt>
                      <dd>
                        {view.loginOk === null ? "unknown" : view.loginOk ? <Badge variant="success">valid</Badge> : <Badge variant="danger">logged out</Badge>}
                        {view.loginDetail && <span className="ml-1 text-muted-foreground">{view.loginDetail}</span>}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Usage limit</dt><dd>{view.limitUntil ? `until ${when(view.limitUntil)}` : "none"}</dd></div>
                  </dl>
                  {view.lastError && <p className="break-words text-xs text-muted-foreground">Last worker error: {view.lastError}</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Queue</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="text-3xl font-semibold" data-testid="queue-length">{view.queue.pending + view.queue.processing + view.queue.waitingLimit}</p>
                  <p className="text-muted-foreground">pages waiting or being read (one at a time)</p>
                  <p>Being read: {view.queue.processing}</p>
                  <p>Queued: {view.queue.pending}</p>
                  <p>Waiting – usage limit: {view.queue.waitingLimit}</p>
                </CardContent>
              </Card>
            </div>

            {(openAlerts.length > 0 || pastAlerts.length > 0) && (
              <Card>
                <CardHeader>
                  <CardTitle>Alerts</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {openAlerts.map((a) => (
                    <Alert key={`${a.kind}-${a.openedAt}`} variant="danger">
                      <strong>{a.kind}</strong> since {when(a.openedAt)} — {a.message}
                    </Alert>
                  ))}
                  {pastAlerts.map((a) => (
                    <p key={`${a.kind}-${a.openedAt}`} className="text-muted-foreground">
                      {when(a.openedAt)} → {when(a.resolvedAt)}: <strong>{a.kind}</strong> — {a.message}
                    </p>
                  ))}
                  <p className="text-xs text-muted-foreground">Email delivery is not configured yet; alerts appear here only.</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Last 20 jobs</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Created</Th>
                      <Th>File</Th>
                      <Th>User</Th>
                      <Th>Status</Th>
                      <Th>Sheets</Th>
                      <Th>Claude time</Th>
                      <Th>Total time</Th>
                      <Th>Error</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.jobs.length === 0 && (
                      <tr>
                        <Td colSpan={8} className="text-muted-foreground">No jobs yet.</Td>
                      </tr>
                    )}
                    {view.jobs.map((j) => (
                      <tr key={j.id}>
                        <Td className="whitespace-nowrap">{when(j.createdAt)}</Td>
                        <Td className="max-w-[16rem] truncate" title={j.filename}>{j.filename}</Td>
                        <Td className="max-w-[12rem] truncate" title={j.email}>{j.email}</Td>
                        <Td><Badge variant={JOB[j.status]?.v ?? "default"}>{JOB[j.status]?.label ?? j.status}</Badge></Td>
                        <Td className="whitespace-nowrap">
                          {j.done}/{j.pages}
                          {j.errors > 0 && <span className="ml-1 text-red-700">({j.errors} failed)</span>}
                          {j.waiting > 0 && <span className="ml-1 text-amber-800">({j.waiting} waiting)</span>}
                        </Td>
                        <Td className="whitespace-nowrap">{dur(j.claudeMs || null)}</Td>
                        <Td className="whitespace-nowrap">{dur(j.wallMs)}</Td>
                        <Td className="max-w-[18rem] truncate text-xs" title={j.lastError ?? ""}>{j.lastError ?? ""}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
