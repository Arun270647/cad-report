import type { ReferenceView } from "@/lib/contract";
import { sql } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { getCatalog, loadReferenceMeta } from "@/lib/server/reference";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET (signed in) → ReferenceView: which price list / template are active and the report margin. */
export const GET = handle(async (req: Request) => {
  requireSession(req);
  const db = sql();
  const meta = await loadReferenceMeta(db);
  const [s] = await db<{ margin: string | number | null }[]>`SELECT margin FROM bom.settings WHERE id = 1`;
  const catalog = meta.price_list ? await getCatalog(db) : null;
  const view: ReferenceView = {
    priceList: meta.price_list ? { ...meta.price_list, parts: catalog?.count ?? 0 } : null,
    template: meta.template,
    margin: s?.margin != null ? Number(s.margin) : 0.125,
  };
  return json(view);
});
