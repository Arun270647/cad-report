import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import SignOutButton from "./sign-out";

export const dynamic = "force-dynamic";

const userLinks = [
  { href: "/dashboard", label: "New conversion" },
  { href: "/jobs", label: "My jobs" },
];
const adminLinks = [
  { href: "/admin/api", label: "API connection" },
  { href: "/admin/health", label: "API health" },
  { href: "/admin/price-files", label: "Price files" },
  { href: "/admin/settings", label: "Template & rules" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/jobs", label: "All jobs" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  if (session.user.mustChangePassword) redirect("/change-password");
  const isAdmin = session.user.role === "ADMIN";
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="font-semibold text-primary">
            ⚡ Panel BOM Pricer
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm">
            {userLinks.map((l) => (
              <Link key={l.href} href={l.href} className="rounded px-2 py-1 hover:bg-muted">
                {l.label}
              </Link>
            ))}
            {isAdmin && <span className="mx-2 self-center text-xs font-semibold uppercase text-muted-foreground">Admin</span>}
            {isAdmin &&
              adminLinks.map((l) => (
                <Link key={l.href} href={l.href} className="rounded px-2 py-1 hover:bg-muted">
                  {l.label}
                </Link>
              ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <span>
              {session.user.email} · {session.user.role}
            </span>
            <Link href="/change-password" className="hover:underline">
              Password
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6">{children}</main>
    </div>
  );
}
