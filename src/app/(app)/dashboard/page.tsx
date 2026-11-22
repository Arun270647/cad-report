"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtPct } from "@/lib/utils";

interface Status {
  conversionsEnabled: boolean;
  reason: string | null;
  priceFile: { version: number; filename: string } | null;
  template: string | null;
  margin: number;
}

export default function NewConversionPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ status: Status }>("/api/jobs").then((d) => setStatus(d.status)).catch((e) => setError(e.message));
  }, []);

  async function start() {
    if (!file) return;
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type !== "application/pdf")) return setError("Only PDF files are accepted.");
    if (file.size > 25 * 1024 * 1024) return setError("The PDF is larger than 25 MB.");
    try {
      setProgress("Creating job…");
      const job = await api<{ id: string; chunkSize: number; chunkCount: number }>("/api/jobs", {
        method: "POST",
        json: { filename: file.name, size: file.size },
      });
      for (let i = 0; i < job.chunkCount; i++) {
        setProgress(`Uploading ${Math.round(((i + 1) / job.chunkCount) * 100)}%`);
        const blob = file.slice(i * job.chunkSize, (i + 1) * job.chunkSize);
        await api(`/api/jobs/${job.id}/chunk?idx=${i}`, { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });
      }
      router.push(`/jobs/${job.id}?run=1`);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  const reasonText: Record<string, string> = {
    maintenance: "Conversions are temporarily disabled for maintenance.",
    budget: "The monthly API budget has been reached. Contact an administrator.",
    not_configured: "The extraction service has not been configured yet. Contact an administrator.",
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New conversion</h1>
        <p className="text-sm text-muted-foreground">Upload a control-panel drawing PDF. The active price file and template are applied automatically.</p>
      </div>
      {status && !status.conversionsEnabled && <Alert variant="warning">{reasonText[status.reason ?? ""] ?? "Conversions are unavailable."}</Alert>}
      {status && !status.priceFile && <Alert variant="warning">No active price file yet — ask an administrator to upload one.</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Drawing PDF</CardTitle>
          <CardDescription>
            Price file: {status?.priceFile ? `v${status.priceFile.version} – ${status.priceFile.filename}` : "—"} · Template: {status?.template ?? "built-in A–N layout"} · Margin:{" "}
            {status ? fmtPct(status.margin) : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/50 p-10 text-center hover:bg-muted"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
          >
            <p className="font-medium">{file ? file.name : "Drop a PDF here or click to choose"}</p>
            <p className="text-xs text-muted-foreground">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF only, up to 25 MB"}</p>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          {error && <Alert variant="danger">{error}</Alert>}
          <Button onClick={start} disabled={!file || !!progress || !status?.conversionsEnabled || !status?.priceFile} className="w-full">
            {progress ?? "Start conversion"}
          </Button>
          <ol className="grid grid-cols-4 gap-2 text-center text-xs text-muted-foreground">
            <li>1. Rendering pages</li>
            <li>2. Extracting (per sheet)</li>
            <li>3. Matching</li>
            <li>4. Ready for review</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
