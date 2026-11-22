"use client";
import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui";
import { api } from "@/lib/fetcher";

export default function ChangePasswordPage() {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError("Passwords do not match");
    if (next.length < 10) return setError("Use at least 10 characters");
    setBusy(true);
    try {
      await api("/api/account/password", { method: "POST", json: { currentPassword: current, newPassword: next } });
      await update(); // refresh JWT so mustChangePassword is cleared
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Change your password</CardTitle>
          <CardDescription>
            {session?.user?.mustChangePassword ? "You must set a new password before continuing." : "Update your password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Current / temporary password</Label>
              <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>New password (min 10 characters)</Label>
              <Input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Confirm new password</Label>
              <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <Alert variant="danger">{error}</Alert>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Saving…" : "Save password"}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => signOut({ callbackUrl: "/login" })}>
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
