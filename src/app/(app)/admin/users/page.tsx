"use client";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/fetcher";
import { fmtDate, fmtMoney } from "@/lib/utils";

interface U { id: string; email: string; name: string | null; role: "ADMIN" | "USER"; active: boolean; mustChangePassword: boolean; createdAt: string; lastLoginAt: string | null; jobCount: number; apiCalls: number; apiCost: number; tokens: number }

export default function UsersPage() {
  const [users, setUsers] = useState<U[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [msg, setMsg] = useState<{ v: "success" | "danger" | "info"; t: string } | null>(null);
  const load = () => api<{ users: U[] }>("/api/admin/users").then((d) => setUsers(d.users));
  useEffect(() => { load().catch((e) => setMsg({ v: "danger", t: e.message })); }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ email: string; temporaryPassword: string }>("/api/admin/users", { method: "POST", json: { email, name: name || undefined, role } });
      setMsg({ v: "info", t: `Invited ${r.email}. Temporary password (shown once — share it securely): ${r.temporaryPassword}` });
      setEmail(""); setName("");
      await load();
    } catch (err) { setMsg({ v: "danger", t: (err as Error).message }); }
  }
  async function act(u: U, action: string) {
    try {
      const r = await api<{ temporaryPassword?: string }>(`/api/admin/users/${u.id}`, { method: "PATCH", json: { action } });
      if (r.temporaryPassword) setMsg({ v: "info", t: `Password reset for ${u.email}. Temporary password (shown once): ${r.temporaryPassword}` });
      await load();
    } catch (err) { setMsg({ v: "danger", t: (err as Error).message }); }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">User management</h1>
      {msg && <Alert variant={msg.v} className="font-mono text-xs md:text-sm">{msg.t}</Alert>}
      <Card>
        <CardHeader><CardTitle>Invite user</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={invite} className="flex flex-wrap gap-2">
            <Input type="email" required placeholder="email@company.com" className="max-w-xs" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input placeholder="Name (optional)" className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={role} onChange={(e) => setRole(e.target.value as "USER" | "ADMIN")}><option value="USER">USER</option><option value="ADMIN">ADMIN</option></Select>
            <Button type="submit">Invite</Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">A one-time temporary password is generated; the user must change it at first login.</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <Table className="text-sm">
            <thead><tr><Th>Email</Th><Th>Role</Th><Th>Status</Th><Th>Jobs</Th><Th>API calls</Th><Th>Tokens</Th><Th>API cost</Th><Th>Last login</Th><Th></Th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <Td>{u.email}{u.name && <div className="text-xs text-muted-foreground">{u.name}</div>}</Td>
                  <Td><Badge variant={u.role === "ADMIN" ? "purple" : "default"}>{u.role}</Badge></Td>
                  <Td>{u.active ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Deactivated</Badge>}{u.mustChangePassword && <Badge variant="warning" className="ml-1">Temp password</Badge>}</Td>
                  <Td>{u.jobCount}</Td><Td>{u.apiCalls}</Td><Td>{u.tokens.toLocaleString()}</Td><Td>${fmtMoney(u.apiCost, 4)}</Td><Td>{fmtDate(u.lastLoginAt)}</Td>
                  <Td className="space-x-1 whitespace-nowrap">
                    {u.active ? <Button size="sm" variant="outline" onClick={() => act(u, "deactivate")}>Deactivate</Button> : <Button size="sm" variant="outline" onClick={() => act(u, "activate")}>Activate</Button>}
                    <Button size="sm" variant="outline" onClick={() => act(u, "reset")}>Reset password</Button>
                    {u.role === "USER" ? <Button size="sm" variant="ghost" onClick={() => act(u, "makeAdmin")}>Make admin</Button> : <Button size="sm" variant="ghost" onClick={() => act(u, "makeUser")}>Make user</Button>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
