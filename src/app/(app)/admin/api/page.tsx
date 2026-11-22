"use client";
import { useEffect, useState } from "react";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/fetcher";

interface KeyInfo { configured: boolean; masked: string | null; model: string; models: { id: string; label: string }[]; conversionsEnabled: boolean }

export default function ApiConnectionPage() {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<{ v: "success" | "danger" | "info"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<KeyInfo>("/api/admin/api-key").then((d) => { setInfo(d); setModel(d.model); });
  useEffect(() => { load().catch((e) => setMsg({ v: "danger", t: e.message })); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/api-key", { method: "PUT", json: { ...(key ? { apiKey: key } : {}), model } });
      setKey("");
      setMsg({ v: "success", t: key ? "API key encrypted and saved." : "Model saved." });
      await load();
    } catch (err) { setMsg({ v: "danger", t: (err as Error).message }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    setMsg({ v: "info", t: "Testing…" });
    try {
      const r = await api<{ ok: boolean; latencyMs?: number; model?: string; errorType?: string; message?: string }>("/api/admin/api-key/test", { method: "POST" });
      setMsg(r.ok ? { v: "success", t: `Connected ✓ — ${r.latencyMs} ms, model ${r.model}` } : { v: "danger", t: `Failed (${r.errorType}): ${r.message}` });
    } catch (err) { setMsg({ v: "danger", t: (err as Error).message }); } finally { setBusy(false); }
  }
  async function toggle() {
    if (!info) return;
    await api("/api/admin/api-key", { method: "PUT", json: { conversionsEnabled: !info.conversionsEnabled } });
    await load();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">API connection</h1>
      <Card>
        <CardHeader>
          <CardTitle>Claude API key</CardTitle>
          <CardDescription>Encrypted at rest with AES-256-GCM (ENCRYPTION_KEY). Only the last 4 characters are ever shown; the key never reaches the browser.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Current key</Label>
              <p className="font-mono text-sm">{info?.configured ? info.masked : "Not configured"}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="k">{info?.configured ? "Replace key" : "Enter key"}</Label>
              <Input id="k" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <Select value={model} onChange={(e) => setModel(e.target.value)} className="w-full">
                {info?.models.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.id}</option>)}
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Save</Button>
              <Button type="button" variant="outline" onClick={test} disabled={busy || !info?.configured}>Test connection</Button>
            </div>
            {msg && <Alert variant={msg.v}>{msg.t}</Alert>}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Maintenance mode</CardTitle>
          <CardDescription>Disable conversions globally for all users.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <span className={info?.conversionsEnabled ? "text-emerald-700" : "text-red-700"}>
            Conversions are {info?.conversionsEnabled ? "ENABLED" : "DISABLED"}
          </span>
          <Button variant={info?.conversionsEnabled ? "destructive" : "default"} onClick={toggle}>
            {info?.conversionsEnabled ? "Disable conversions" : "Enable conversions"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
