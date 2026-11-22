import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAGE_JSON_SCHEMA as APP_SCHEMA } from "@/lib/bom/page-schema";
import { DEVICE_TYPES as APP_DEVICE_TYPES } from "@/lib/bom/types";
import { PAGE_JSON_SCHEMA as WORKER_SCHEMA, DEVICE_TYPES as WORKER_DEVICE_TYPES } from "../worker/prompt.mjs";
import { buildClaudeArgs, loadConfig, prepare, runOnce, sanitizedEnv, splitCommand, parseEnvFile } from "../worker/worker.mjs";

const FAKE = path.resolve(__dirname, "../worker/fake-claude.mjs");
const TOKEN = "test-token-0123456789abcdef0123456789";
// 1x1 PNG
const IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("worker prompt constants", () => {
  it("PAGE_JSON_SCHEMA matches the app's schema", () => {
    expect(JSON.parse(JSON.stringify(WORKER_SCHEMA))).toEqual(JSON.parse(JSON.stringify(APP_SCHEMA)));
    expect([...WORKER_DEVICE_TYPES]).toEqual([...APP_DEVICE_TYPES]);
  });
  it("claude args are constant and contain no permission bypass", () => {
    const args = buildClaudeArgs("");
    expect(args.slice(0, 3)).toEqual(["-p", "--tools", ""]);
    for (const f of ["--restricted", "--strict-mcp-config", "--no-session-persistence", "--json-schema", "--system-prompt"]) {
      expect(args).toContain(f);
    }
    expect(args.join(" ")).not.toMatch(/--bare|dangerously|bypass/);
    expect(buildClaudeArgs("claude-opus-5-5").slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
  });
  it("helpers", () => {
    expect(splitCommand(`"C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\cli.js"`)).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\x y\\cli.js",
    ]);
    expect(splitCommand("node /a/fake.mjs")).toEqual(["node", "/a/fake.mjs"]);
    expect(parseEnvFile("# c\nexport A=1\nB=\"two words\"\nC=3 # note\n")).toEqual({ A: "1", B: "two words", C: "3" });
    const env = sanitizedEnv({ ANTHROPIC_API_KEY: "x", anthropic_base_url: "y", WORKER_TOKEN: "z", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

type Posted = Record<string, any>;

describe("worker against a fake server + fake claude", () => {
  let server: http.Server;
  let url = "";
  let queue: object[] = [];
  let posted: Posted[] = [];
  let nextHeaders: http.IncomingHttpHeaders[] = [];
  let workDir = "";
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/worker/next")) {
        nextHeaders.push(req.headers);
        const t = queue.shift();
        if (!t) res.writeHead(204).end();
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(t));
        return;
      }
      if (req.method === "POST" && req.url === "/api/worker/result") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          posted.push(JSON.parse(body));
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    workDir = mkdtempSync(path.join(os.tmpdir(), "worker-test-"));
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "WORKER_TOKEN", "FAKE_CLAUDE_MODE"]) saved[k] = process.env[k];
    // These must NOT reach the child.
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-not-leak";
    process.env.WORKER_TOKEN = TOKEN;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
    rmSync(workDir, { recursive: true, force: true });
  });

  const cfg = (over: Record<string, unknown> = {}) => ({
    ...loadConfig({}, null),
    workerUrl: url,
    token: TOKEN,
    claudeBin: `"${process.execPath}" "${FAKE}"`,
    workDir,
    taskTimeoutMs: 20000,
    ...over,
  });

  async function runWith(mode: string, over: Record<string, unknown> = {}) {
    process.env.FAKE_CLAUDE_MODE = mode;
    posted = [];
    queue = [{ jobId: "11111111-2222-3333-4444-555555555555", page: 3, attempt: 1, mediaType: "image/png", data: IMAGE }];
    const c = cfg(over);
    const prep = await prepare(c);
    const r = await runOnce(c, prep);
    expect(r.status).toBe("processed");
    expect(posted).toHaveLength(1);
    return { r, body: posted[0] };
  }

  it("returns idle when there is no task, and sends x-worker-info", async () => {
    queue = [];
    nextHeaders = [];
    const c = cfg();
    const r = await runOnce(c, await prepare(c));
    expect(r.status).toBe("idle");
    expect(nextHeaders[0]["x-worker-info"]).toMatch(/ claude 9\.9\.9$/);
  });

  it("ok → posts the extraction, child had a sanitized env and no image in argv", async () => {
    const { body } = await runWith("ok");
    expect(body.ok).toBe(true);
    expect(body.jobId).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.page).toBe(3);
    expect(body.model).toBe("fake-model-1");
    expect(typeof body.durationMs).toBe("number");
    expect(body.result.components[0].tag).toBe("Q1");
    expect(body.result.notes).toEqual(
      expect.arrayContaining([
        "env:ANTHROPIC_API_KEY=absent",
        "env:ANTHROPIC_AUTH_TOKEN=absent",
        "env:WORKER_TOKEN=absent",
        "argv-has-image=false",
        "flags-ok=true",
        "cwd-empty=true",
        "stdin-ok=true",
      ]),
    );
    // per-task dirs are cleaned up
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("fenced result text is parsed", async () => {
    const { body } = await runWith("fenced");
    expect(body.ok).toBe(true);
    expect(body.result.sheet_number).toBe("3");
  });

  it("garbage → ok:false retryable", async () => {
    const { body } = await runWith("garbage");
    expect(body).toMatchObject({ ok: false, retryable: true });
    expect(body.error).toMatch(/not a page extraction/);
  });

  it("not logged in → ok:false retryable with login hint and 60 s backoff", async () => {
    const { r, body } = await runWith("notloggedin");
    expect(body).toMatchObject({ ok: false, retryable: true });
    expect(body.error).toMatch(/not logged in/i);
    expect(r.backoffMs).toBe(60000);
  });

  it("slow → killed at the timeout, ok:false retryable", async () => {
    const { body } = await runWith("slow", { taskTimeoutMs: 1500 });
    expect(body).toMatchObject({ ok: false, retryable: true });
    expect(body.error).toMatch(/timed out/);
  });

  it("never posts the token or image data in errors", async () => {
    const { body } = await runWith("garbage");
    const s = JSON.stringify(body);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain(IMAGE.slice(0, 40));
  });
});
