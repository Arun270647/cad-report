import { describe, expect, it } from "vitest";
import { backoffMs, pageFromView, recordsFromJob } from "@/lib/client/convert";
import type { JobView } from "@/lib/contract";
import type { PageExtraction } from "@/lib/bom/types";

const res = (sheet_status: PageExtraction["sheet_status"]): PageExtraction => ({
  sheet_number: "3", sheet_title: null, sheet_status, components: [], terminal_blocks: [], notes: [],
});
const view = (page: number, status: JobView["pages"][number]["status"], extra: Partial<JobView["pages"][number]> = {}) => ({
  page, status, skipReason: null, error: null, result: null, ...extra,
});

describe("client job mapping", () => {
  it("maps page states to progress stages", () => {
    expect(pageFromView(view(1, "awaiting_upload"))).toMatchObject({ status: "pending", stage: "uploading" });
    expect(pageFromView(view(1, "pending"))).toMatchObject({ status: "pending", stage: "queued" });
    expect(pageFromView(view(1, "processing"))).toMatchObject({ status: "pending", stage: "reading" });
    expect(pageFromView(view(1, "skipped", { skipReason: "Blank sheet" }))).toMatchObject({ status: "skipped", skipReason: "Blank sheet" });
    expect(pageFromView(view(1, "error", { error: "timed out" }))).toMatchObject({ status: "error", error: "timed out" });
  });

  it("builds sorted PageRecords and treats non-content results as skipped", () => {
    const job: JobView = {
      id: "j", filename: "a.pdf", status: "done", createdAt: "", queuePosition: 0,
      pages: [
        view(3, "done", { result: res("reserved") }),
        view(1, "done", { result: res("content") }),
        view(2, "done", { result: res("blank") }),
        view(4, "error", { error: "bad" }),
      ],
    };
    const recs = recordsFromJob(job);
    expect(recs.map((r) => r.page)).toEqual([1, 2, 3, 4]);
    expect(recs[0]).toMatchObject({ status: "done", sheet: "3" });
    expect(recs[0].result?.sheet_status).toBe("content");
    expect(recs[1]).toMatchObject({ status: "skipped", skipReason: "Blank sheet" });
    expect(recs[2]).toMatchObject({ status: "skipped", skipReason: "RESERVED sheet" });
    expect(recs[3]).toMatchObject({ status: "error", error: "bad" });
    expect(recs.every((r) => !("stage" in r))).toBe(true);
  });

  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 15000]);
  });
});
