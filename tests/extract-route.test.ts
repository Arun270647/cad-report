import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("/api/extract", () => {
  it("reports a missing API key without leaking anything", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.APP_PASSCODE;
    const { POST } = await import("@/app/api/extract/route");
    const res = await POST(new Request("http://x/api/extract", { method: "POST", body: JSON.stringify({ page: 1, mediaType: "image/png", data: "A".repeat(200) }) }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("not_configured");
  });
  it("enforces the optional passcode", async () => {
    process.env.APP_PASSCODE = "secret";
    const { POST } = await import("@/app/api/extract/route");
    const res = await POST(new Request("http://x/api/extract", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    delete process.env.APP_PASSCODE;
  });
  it("redacts API keys from messages", async () => {
    const { redactSecrets } = await import("@/lib/server/extract");
    expect(redactSecrets("bad sk-ant-api03-abc_DEF")).toBe("bad sk-ant-***");
  });
});
