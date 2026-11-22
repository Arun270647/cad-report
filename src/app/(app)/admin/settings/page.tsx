"use client";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtDate } from "@/lib/utils";
import { DEVICE_TYPES } from "@/lib/bom/types";

interface S { defaultMargin: number; monthlyBudget: number | null; budgetCurrency: "USD" | "INR"; usdToInr: number; maxConversionsPerHour: number }
interface Tpl { id: string; filename: string; active: boolean; createdAt: string }
interface Rule { id: number; deviceType: string; rating: string; qualifier: string | null; mpn: string; notes: string | null }
const emptyRule = { deviceType: "MPCB", rating: "", qualifier: "", mpn: "", notes: "" };

export default function TemplateSettingsPage() {
  const [s, setS] = useState<S | null>(null);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [tplFile, setTplFile] = useState<File | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<typeof emptyRule & { id?: number }>(emptyRule);
  const [msg, setMsg] = useState<{ v: "success" | "danger"; t: string } | null>(null);

  const load = async () => {
    const [a, b, c] = await Promise.all([
      api<S>("/api/admin/settings"),
      api<{ templates: Tpl[] }>("/api/admin/template"),
      api<{ rules: Rule[] }>("/api/admin/rules"),
    ]);
    setS(a); setTpls(b.templates); setRules(c.rules);
  };
  useEffect(() => { load().catch((e) => setMsg({ v: "danger", t: e.message })); }, []);
  const flash = (v: "success" | "danger", t: string) => setMsg({ v, t });

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    try {
      await api("/api/admin/settings", { method: "PUT", json: s });
      flash("success", "Settings saved.");
    } catch (err) { flash("danger", (err as Error).message); }
  }
  async function uploadTpl() {
    if (!tplFile) return;
    const fd = new FormData();
    fd.append("file", tplFile);
    try { await api("/api/admin/template", { method: "POST", body: fd }); flash("success", "Template uploaded and activated."); setTplFile(null); await load(); }
    catch (err) { flash("danger", (err as Error).message); }
  }
  async function activateTpl(id: string) { await api("/api/admin/template", { method: "PATCH", json: { id } }); await load(); }
  async function saveRule(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = { deviceType: draft.deviceType, rating: draft.rating, qualifier: draft.qualifier || null, mpn: draft.mpn, notes: draft.notes || null };
      if (draft.id) await api(`/api/admin/rules/${draft.id}`, { method: "PUT", json: body });
      else await api("/api/admin/rules", { method: "POST", json: body });
      setDraft(emptyRule);
      await load();
    } catch (err) { flash("danger", (err as Error).message); }
  }
  async function delRule(id: number) { await api(`/api/admin/rules/${id}`, { method: "DELETE" }); await load(); }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Template & settings</h1>
      {msg && <Alert variant={msg.v}>{msg.t}</Alert>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Output template (.xlsx)</CardTitle><CardDescription>Row 1 must hold the A–N headers: TEREX P/N … Total Price. Column widths and sheet setup are preserved on export.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2"><Input type="file" accept=".xlsx" onChange={(e) => setTplFile(e.target.files?.[0] ?? null)} /><Button onClick={uploadTpl} disabled={!tplFile}>Upload</Button></div>
            <Table><tbody>{tpls.map((t) => (
              <tr key={t.id}><Td>{t.filename}</Td><Td>{fmtDate(t.createdAt)}</Td><Td>{t.active ? <Badge variant="success">Active</Badge> : <Button size="sm" variant="outline" onClick={() => activateTpl(t.id)}>Activate</Button>}</Td></tr>
            ))}{tpls.length === 0 && <tr><Td className="text-muted-foreground">No template uploaded — the built-in A–N layout is used.</Td></tr>}</tbody></Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pricing, budget & limits</CardTitle></CardHeader>
          <CardContent>
            {s && (
              <form onSubmit={saveSettings} className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>Default margin (fraction)</Label><Input type="number" step="0.001" min="0" value={s.defaultMargin} onChange={(e) => setS({ ...s, defaultMargin: Number(e.target.value) })} /></div>
                <div className="space-y-1"><Label>Conversions per user / hour</Label><Input type="number" min="1" value={s.maxConversionsPerHour} onChange={(e) => setS({ ...s, maxConversionsPerHour: Number(e.target.value) })} /></div>
                <div className="space-y-1"><Label>Monthly budget cap (blank = none)</Label><Input type="number" step="0.01" min="0" value={s.monthlyBudget ?? ""} onChange={(e) => setS({ ...s, monthlyBudget: e.target.value === "" ? null : Number(e.target.value) })} /></div>
                <div className="space-y-1"><Label>Currency</Label><Select className="w-full" value={s.budgetCurrency} onChange={(e) => setS({ ...s, budgetCurrency: e.target.value as "USD" | "INR" })}><option value="USD">USD ($)</option><option value="INR">INR (₹)</option></Select></div>
                <div className="space-y-1"><Label>USD → INR rate</Label><Input type="number" step="0.01" value={s.usdToInr} onChange={(e) => setS({ ...s, usdToInr: Number(e.target.value) })} /></div>
                <div className="col-span-2 text-xs text-muted-foreground">Alerts show at 80% and 100% of the cap; new conversions are blocked at 100%.</div>
                <Button type="submit" className="col-span-2">Save settings</Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Matching rules</CardTitle><CardDescription>Device type → exact rating (→ optional qualifier such as coil voltage or colour) → manufacturer P/N. Example: MPCB · 13-18A → GV2ME20. Leave rating as “-” for ratingless devices.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={saveRule} className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <Select value={draft.deviceType} onChange={(e) => setDraft({ ...draft, deviceType: e.target.value })}>{DEVICE_TYPES.map((d) => <option key={d}>{d}</option>)}</Select>
            <Input placeholder="Rating e.g. 13-18A" value={draft.rating} onChange={(e) => setDraft({ ...draft, rating: e.target.value })} />
            <Input placeholder="Qualifier (optional) e.g. 24VDC / RED" value={draft.qualifier} onChange={(e) => setDraft({ ...draft, qualifier: e.target.value })} />
            <Input placeholder="Manufacturer P/N" required value={draft.mpn} onChange={(e) => setDraft({ ...draft, mpn: e.target.value })} />
            <Input placeholder="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            <div className="flex gap-2"><Button type="submit">{draft.id ? "Update" : "Add rule"}</Button>{draft.id && <Button type="button" variant="ghost" onClick={() => setDraft(emptyRule)}>Cancel</Button>}</div>
          </form>
          <Table className="text-sm">
            <thead><tr><Th>Device type</Th><Th>Rating</Th><Th>Qualifier</Th><Th>Manufacturer P/N</Th><Th>Notes</Th><Th></Th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}><Td>{r.deviceType}</Td><Td>{r.rating}</Td><Td>{r.qualifier}</Td><Td className="font-mono">{r.mpn}</Td><Td>{r.notes}</Td>
                  <Td className="space-x-2 whitespace-nowrap"><Button size="sm" variant="outline" onClick={() => setDraft({ id: r.id, deviceType: r.deviceType, rating: r.rating, qualifier: r.qualifier ?? "", mpn: r.mpn, notes: r.notes ?? "" })}>Edit</Button><Button size="sm" variant="ghost" onClick={() => delRule(r.id)}>Delete</Button></Td></tr>
              ))}
              {rules.length === 0 && <tr><Td colSpan={6} className="text-center text-muted-foreground">No rules yet.</Td></tr>}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
