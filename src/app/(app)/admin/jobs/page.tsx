"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Card, CardContent, Input, Table, Td, Th } from "@/components/ui";
import { StatusBadge } from "@/components/job-status";
import { api } from "@/lib/fetcher";
import { fmtDate, fmtMoney } from "@/lib/utils";

interface Row { id: string; email: string | null; filename: string; status: string; pageCount: number; costUsd: number; createdAt: string; approvedAt: string | null; parentJobId: string | null }

export default function AllJobsPage() {
  const [jobs, setJobs] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ jobs: Row[] }>("/api/admin/jobs").then((d) => setJobs(d.jobs)).catch((e) => setError(e.message)); }, []);
  const shown = jobs.filter((j) => !q || `${j.email} ${j.filename} ${j.status}`.toLowerCase().includes(q.toLowerCase()));
  const total = shown.reduce((s, j) => s + (j.costUsd ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">All jobs</h1>
        <Input className="max-w-xs" placeholder="Filter by user, file, status" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
      <Card>
        <CardContent className="pt-4">
          <Table className="text-sm">
            <thead><tr><Th>User</Th><Th>Drawing</Th><Th>Status</Th><Th>Pages</Th><Th className="text-right">API cost (USD)</Th><Th>Created</Th><Th>Approved</Th><Th></Th></tr></thead>
            <tbody>
              {shown.map((j) => (
                <tr key={j.id}>
                  <Td>{j.email}</Td><Td>{j.filename}{j.parentJobId && <span className="ml-1 text-xs text-muted-foreground">(re-priced)</span>}</Td><Td><StatusBadge status={j.status} /></Td><Td>{j.pageCount}</Td>
                  <Td className="text-right">${fmtMoney(j.costUsd, 4)}</Td><Td>{fmtDate(j.createdAt)}</Td><Td>{fmtDate(j.approvedAt)}</Td>
                  <Td className="space-x-2 whitespace-nowrap"><Link className="text-sky-700 hover:underline" href={`/jobs/${j.id}`}>Open</Link>{j.status === "approved" && <a className="text-sky-700 hover:underline" href={`/api/jobs/${j.id}/export`}>Excel</a>}</Td>
                </tr>
              ))}
              <tr className="font-semibold"><Td colSpan={4}>Total ({shown.length} jobs)</Td><Td className="text-right">${fmtMoney(total, 4)}</Td><Td colSpan={3} /></tr>
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
