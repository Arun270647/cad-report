"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Card, CardContent, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtDate } from "@/lib/utils";
import { StatusBadge } from "@/components/job-status";

interface Row { id: string; filename: string; status: string; pageCount: number; createdAt: string; approvedAt: string | null; parentJobId: string | null }

export default function MyJobsPage() {
  const [jobs, setJobs] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ jobs: Row[] }>("/api/jobs").then((d) => setJobs(d.jobs)).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My jobs</h1>
      {error && <Alert variant="danger">{error}</Alert>}
      <Card>
        <CardContent className="pt-4">
          <Table>
            <thead>
              <tr><Th>Drawing</Th><Th>Status</Th><Th>Pages</Th><Th>Created</Th><Th>Approved</Th><Th></Th></tr>
            </thead>
            <tbody>
              {jobs?.map((j) => (
                <tr key={j.id}>
                  <Td className="font-medium">{j.filename}{j.parentJobId && <span className="ml-2 text-xs text-muted-foreground">(re-priced)</span>}</Td>
                  <Td><StatusBadge status={j.status} /></Td>
                  <Td>{j.pageCount || "—"}</Td>
                  <Td>{fmtDate(j.createdAt)}</Td>
                  <Td>{fmtDate(j.approvedAt)}</Td>
                  <Td><Link className="text-sky-700 hover:underline" href={`/jobs/${j.id}`}>Open</Link></Td>
                </tr>
              ))}
              {jobs && jobs.length === 0 && <tr><Td colSpan={6} className="py-6 text-center text-muted-foreground">No jobs yet.</Td></tr>}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
