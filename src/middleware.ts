import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

/**
 * Route protection. This is the first layer only — every API route ALSO enforces
 * authentication and roles server-side via requireUser()/requireAdmin().
 */
export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const { pathname } = req.nextUrl;
    const isApi = pathname.startsWith("/api/");
    if (token?.mustChangePassword && !pathname.startsWith("/change-password") && !pathname.startsWith("/api/account/password")) {
      if (isApi) return NextResponse.json({ error: "Password change required" }, { status: 403 });
      return NextResponse.redirect(new URL("/change-password", req.url));
    }
    if ((pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) && token?.role !== "ADMIN") {
      if (isApi) return NextResponse.json({ error: "Admin only" }, { status: 403 });
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  },
  {
    callbacks: { authorized: ({ token }) => !!token },
    pages: { signIn: "/login" },
  },
);

export const config = {
  // Everything except auth endpoints, the cron endpoint (secret-protected), login and static assets.
  matcher: ["/((?!api/auth|api/cron|login|_next/static|_next/image|favicon.ico).*)"],
};
