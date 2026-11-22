import { NextResponse } from "next/server";
import type { ReferenceKind } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, HttpError } from "@/lib/server/http";
import { loadReferenceFile, REFERENCE_KINDS, XLSX_TYPE } from "@/lib/server/reference";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ kind: string }> };

/** GET (signed in) → the active price list or template (.xlsx). Never cached by shared caches. */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  requireSession(req);
  const { kind } = await ctx.params;
  if (!REFERENCE_KINDS.includes(kind as ReferenceKind)) throw new HttpError(404, "not_found", "Unknown reference file");
  const file = await loadReferenceFile(sql(), kind as ReferenceKind);
  if (!file) throw new HttpError(404, "not_configured", `No ${kind.replace("_", " ")} has been loaded yet — ask an admin`);
  return new NextResponse(new Uint8Array(file.content), {
    status: 200,
    headers: {
      "Content-Type": XLSX_TYPE,
      "Cache-Control": "private, no-store",
      ETag: `"${file.sha256}"`,
      "X-Reference-Version": file.sha256,
    },
  });
});
