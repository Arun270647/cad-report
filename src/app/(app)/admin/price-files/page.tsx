"use client";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtDate, fmtMoney, fmtPct } from "@/lib/utils";
import type { PriceIssue } from "@/lib/bom/pricefile";

interface PF { id: string; version: number; filename: string; active: boolean; rowCount: number; createdAt: string }

export default function PriceFilesPage() {
  const [files, setFiles] = useState<PF[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ v: "success" | "danger"; t: string } | null>(null);
  const [issues, setIssues] = useState<{ pf: PF; list: PriceIssue[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ files: PF[] }>("/api/admin/price-files").then((d) => setFiles(d.files));
  useEffect(() => { load().catch((e) => setMsg({ v: "danger", t: e.message })); }, []);

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api<{ version: number; rowCount: number; conflicts: number; duplicates: number }>("/api/admin/price-files", { method: "POST", body: fd });
      setMsg({ v: "success", t: `Uploaded v${r.version}: ${r.rowCount} rows, ${r.conflicts} conflicting P/Ns, ${r.duplicates} duplicates.` });
      setFile(null);
      await load();
    } catch (e) { setMsg({ v: "danger", t: (e as Error).message }); } finally { setBusy(false); }
  }
  async function activate(pf: PF) {
    await api(`/api/admin/price-files/${pf.id}`, { method: "PATCH" });
    await load();
  }
  async function showIssues(pf: PF) {
    const r = await api<{ issues: PriceIssue[] }>(`/api/admin/price-files/${pf.id}/issues`);
    setIssues({ pf, list: r.issues });
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Price files</h1>
      <Card>
        <CardHeader>
          <CardTitle>Upload a new version (.xlsx)</CardTitle>
          <CardDescription>Columns: TEREX P/N, WHERE USED, DRG SHEET NO, DESCRIPTION, MANUFACTURE P/N, MAKE, UOM, QTY, LIST PRICE, Disc, Unit price, Margin, Terex Unit price, Total Price, TAG NO. Max 4 MB.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="max-w-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button onClick={upload} disabled={!file || busy}>{busy ? "Uploading…" : "Upload"}</Button>
          {msg && <Alert variant={msg.v} className="w-full">{msg.t}</Alert>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Versions</CardTitle><CardDescription>Only one version is active. Older versions are kept for re-pricing history.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <thead><tr><Th>Version</Th><Th>File</Th><Th>Rows</Th><Th>Uploaded</Th><Th>Status</Th><Th></Th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <Td>v{f.version}</Td><Td>{f.filename}</Td><Td>{f.rowCount}</Td><Td>{fmtDate(f.createdAt)}</Td>
                  <Td>{f.active ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="space-x-2 whitespace-nowrap">
                    {!f.active && <Button size="sm" onClick={() => activate(f)}>Activate</Button>}
                    <Button size="sm" variant="outline" onClick={() => showIssues(f)}>Duplicates & conflicts</Button>
                    <a href={`/api/admin/price-files/${f.id}`} className="text-sm text-sky-700 hover:underline">Download</a>
                  </Td>
                </tr>
              ))}
              {files.length === 0 && <tr><Td colSpan={6} className="text-center text-muted-foreground">No price files yet.</Td></tr>}
            </tbody>
          </Table>
        </CardContent>
      </Card>
      {issues && (
        <Card>
          <CardHeader>
            <CardTitle>v{issues.pf.version}: {issues.list.filter((i) => i.kind === "conflict").length} conflicts, {issues.list.filter((i) => i.kind === "duplicate").length} duplicates</CardTitle>
            <CardDescription>Same manufacturer P/N with different prices (conflict) or repeated with the same price (duplicate). Clean these up in the source file and upload a new version.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="text-xs">
              <thead><tr><Th>Mfr P/N</Th><Th>Type</Th><Th>Row</Th><Th>Terex P/N</Th><Th>Description</Th><Th>Make</Th><Th className="text-right">List</Th><Th className="text-right">Disc</Th><Th className="text-right">Unit</Th></tr></thead>
              <tbody>
                {issues.list.flatMap((i) => i.rows.map((r, j) => (
                  <tr key={`${i.mpn}-${r.rowNumber}`} className={j === 0 ? "border-t-2 border-slate-300" : ""}>
                    <Td className="font-mono">{j === 0 ? i.mpn : ""}</Td>
                    <Td>{j === 0 && <Badge variant={i.kind === "conflict" ? "danger" : "warning"}>{i.kind}</Badge>}</Td>
                    <Td>{r.rowNumber}</Td><Td>{r.terexPn}</Td><Td>{r.description}</Td><Td>{r.make}</Td>
                    <Td className="text-right">{fmtMoney(r.listPrice)}</Td><Td className="text-right">{fmtPct(r.disc)}</Td><Td className="text-right">{fmtMoney(r.unitPrice)}</Td>
                  </tr>
                )))}
                {issues.list.length === 0 && <tr><Td colSpan={9} className="text-center text-muted-foreground">No duplicates or conflicts. 🎉</Td></tr>}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
