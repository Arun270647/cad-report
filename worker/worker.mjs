#!/usr/bin/env node
// Panel BOM Pricer — local worker.
//
// Polls the web app for page images, runs Claude Code headless (on the owner's claude.ai subscription
// login) as a pure function with NO tools, and posts the JSON result back.
//
//   node worker/worker.mjs           run forever
//   node worker/worker.mjs --once    claim at most one task, process it, exit
//   node worker/worker.mjs --check   self-test (flags, login, server auth) without claiming a task
//
// Node >= 20, no npm dependencies. See worker/README.md.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PAGE_JSON_SCHEMA, SYSTEM_PROMPT, userText } from "./prompt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

/** Flags the worker depends on; checked against `claude --help` at startup. */
export const REQUIRED_FLAGS = [
  "--print", "--tools", "--restricted", "--strict-mcp-config", "--no-session-persistence",
  "--input-format", "--output-format", "--json-schema", "--system-prompt", "--verbose",
];

/** Env vars never passed to Claude Code (API-key auth would bypass the subscription; the token is ours). */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "WORKER_TOKEN"];

const AUTH_RE = /not logged in|please run \/login|run \/login|\/login\b|invalid api key|authentication[_ ]error|oauth token (has )?expired|unauthori[sz]ed|\b401\b/i;
const LIMIT_RE = /usage limit|rate[_ ]limit|limit reached|\b429\b|overloaded|\b529\b/i;
const AUTH_HELP = "Claude Code is not logged in — run `claude` once and log in";

// ───────────────────────────── config ─────────────────────────────

/** Tiny .env parser: KEY=VALUE, `export ` prefix, # comments, optional single/double quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out[m[1]] = v;
  }
  return out;
}

function intEnv(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Build config from worker/.env (if present) overlaid with real env vars (real env wins). */
export function loadConfig(env = process.env, envFile = path.join(HERE, ".env")) {
  let fileVars = {};
  if (envFile && existsSync(envFile)) fileVars = parseEnvFile(readFileSync(envFile, "utf8"));
  const get = (k) => (env[k] !== undefined && env[k] !== "" ? env[k] : fileVars[k]);
  return {
    workerUrl: String(get("WORKER_URL") || "").trim().replace(/\/+$/, ""),
    token: String(get("WORKER_TOKEN") || "").trim(),
    claudeBin: String(get("CLAUDE_BIN") || "").trim(),
    claudeModel: String(get("CLAUDE_MODEL") || "").trim(),
    pollIntervalMs: intEnv(get("POLL_INTERVAL_MS"), 5000, 500, 600000),
    taskTimeoutMs: intEnv(get("TASK_TIMEOUT_MS"), 480000, 1000, 3600000),
    concurrency: intEnv(get("CONCURRENCY"), 1, 1, 3),
    // Per-task scratch dirs live here (default <worker dir>/tmp, NOT the system temp dir, which may be on a full C:).
    workDir: path.resolve(String(get("WORK_DIR") || "").trim() || path.join(HERE, "tmp")),
  };
}

function validateConfig(cfg) {
  const problems = [];
  let url;
  try {
    url = new URL(cfg.workerUrl);
  } catch {
    problems.push("WORKER_URL is missing or not a valid URL");
  }
  if (url) {
    const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      problems.push("WORKER_URL must use https:// (plain http is only allowed for localhost)");
    }
  }
  if (!cfg.token) problems.push("WORKER_TOKEN is empty — paste it into worker/.env");
  if (cfg.claudeModel && !/^[A-Za-z0-9._\-[\]]+$/.test(cfg.claudeModel)) problems.push("CLAUDE_MODEL contains unexpected characters");
  return problems;
}

// ───────────────────────────── logging / redaction ─────────────────────────────

let SECRET_TOKEN = "";
function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.warn(new Date().toISOString(), "WARN", ...a); }

/** Strip anything that must never be logged or sent back: our token, API keys, base64 blobs. */
export function redact(text, max = 500) {
  let s = String(text ?? "");
  if (SECRET_TOKEN) s = s.split(SECRET_TOKEN).join("***");
  s = s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
  s = s.replace(/[A-Za-z0-9+/=]{200,}/g, "[data]");
  s = s.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ───────────────────────────── locating claude ─────────────────────────────

/** Split a CLAUDE_BIN value such as `node /x/fake.mjs` or `"C:\Program Files\nodejs\node.exe" "C:\x\cli.js"`. */
export function splitCommand(str) {
  const parts = [];
  let cur = "";
  let q = null;
  let has = false;
  for (const ch of str) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) parts.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) parts.push(cur);
  return parts;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function findOnPath(names, extraDirs = []) {
  const dirs = [...(process.env.PATH || process.env.Path || "").split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const name of names) {
    for (const d of dirs) {
      const p = path.join(d.replace(/^"|"$/g, ""), name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * On Windows, an npm global install gives `claude.cmd`, a batch shim. Spawning a .cmd needs cmd.exe,
 * whose quoting rules would mangle the JSON schema/system prompt, so instead we read the shim, find the
 * real target (cli.js or a native .exe) and spawn THAT with shell:false.
 */
function resolveCmdShim(shimPath) {
  const dir = path.dirname(shimPath);
  const text = readFileSync(shimPath, "utf8");
  const re = /%~?dp0%?\\?([^"%\r\n*]+?\.(?:js|mjs|cjs|exe))/gi;
  let m;
  while ((m = re.exec(text))) {
    const target = path.resolve(dir, m[1]);
    if (!isFile(target)) continue;
    if (/\.exe$/i.test(target)) return { command: target, prefixArgs: [] };
    return { command: process.execPath, prefixArgs: [target] };
  }
  return null;
}

/** Returns { command, prefixArgs, display } — always spawnable with shell:false. */
export function resolveClaude(claudeBin) {
  if (claudeBin) {
    const [command, ...prefixArgs] = splitCommand(claudeBin);
    if (!command) throw new Error("CLAUDE_BIN is empty");
    if (IS_WIN && /\.(cmd|bat)$/i.test(command)) {
      const r = resolveCmdShim(command);
      if (!r) throw new Error(`CLAUDE_BIN points at a .cmd shim whose target could not be found; set CLAUDE_BIN to claude.exe or "node <path>\\cli.js"`);
      return { ...r, prefixArgs: [...r.prefixArgs, ...prefixArgs], display: claudeBin };
    }
    return { command, prefixArgs, display: claudeBin };
  }
  if (!IS_WIN) return { command: "claude", prefixArgs: [], display: "claude" };
  const home = process.env.USERPROFILE || os.homedir();
  const extra = [path.join(home, ".local", "bin")];
  if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, "npm"));
  const exe = findOnPath(["claude.exe"], extra);
  if (exe) return { command: exe, prefixArgs: [], display: exe };
  const shim = findOnPath(["claude.cmd"], extra);
  if (shim) {
    const r = resolveCmdShim(shim);
    if (r) return { ...r, display: `${r.command} ${r.prefixArgs.join(" ")}`.trim() };
  }
  throw new Error("Could not find Claude Code (claude.exe / claude.cmd) on PATH. Install it, or set CLAUDE_BIN in worker/.env.");
}

// ───────────────────────────── child process helpers ─────────────────────────────

/** Copy of process.env without credentials Claude Code must not see (case-insensitive for Windows). */
export function sanitizedEnv(base = process.env) {
  const out = {};
  const strip = new Set(STRIPPED_ENV.map((k) => k.toUpperCase()));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || strip.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

const liveChildren = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false }).on("error", () => {});
    } else {
      process.kill(-child.pid, "SIGKILL"); // whole process group (child spawned detached)
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Spawn claude with constant args, optional stdin, sanitized env, given cwd, and a timeout.
 * onLine(line) is called for each stdout line (stdout is not buffered as a whole).
 */
function runChild(claude, args, { stdin, cwd, timeoutMs, onLine, maxStdout = 64 * 1024 * 1024 }) {
  // Point the child's temp dir at its own scratch cwd too (keeps writes off a small system drive).
  const env = { ...sanitizedEnv(), TMP: cwd, TEMP: cwd, TMPDIR: cwd };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claude.command, [...claude.prefixArgs, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: !IS_WIN,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, spawnError: e, stderr: "", timedOut: false, stdout: "" });
      return;
    }
    liveChildren.add(child);
    let stderr = "";
    let stdoutAll = "";
    let pending = "";
    let total = 0;
    let timedOut = false;
    let tooBig = false;
    let spawnError = null;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxStdout) { if (!tooBig) { tooBig = true; killTree(child); } return; }
      if (!onLine) { stdoutAll += chunk; return; }
      pending += chunk;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { if (stderr.length < 65536) stderr += c; });
    child.on("error", (e) => { spawnError = e; });
    child.stdin.on("error", () => { /* EPIPE if claude exits early */ });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code, signal, stderr, timedOut, tooBig, spawnError, stdout: stdoutAll });
    });
  });
}

// ───────────────────────────── claude invocation ─────────────────────────────

/** The full, constant argument list. Nothing from the task goes here. */
export function buildClaudeArgs(model) {
  const args = [
    "-p",
    "--tools", "",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--json-schema", JSON.stringify(PAGE_JSON_SCHEMA),
    "--system-prompt", SYSTEM_PROMPT,
  ];
  if (model) args.push("--model", model);
  return args;
}

/** The single stream-json user message written to stdin. */
export function buildStdinMessage(task) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: task.mediaType, data: task.data } },
        { type: "text", text: userText(task.page) },
      ],
    },
  }) + "\n";
}

const REQUIRED_KEYS = ["sheet_number", "sheet_title", "sheet_status", "components", "terminal_blocks", "notes"];

/** Light shape check only — the server validates strictly with zod. */
export function looksLikePage(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!REQUIRED_KEYS.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return false;
  return Array.isArray(v.components) && Array.isArray(v.terminal_blocks) && Array.isArray(v.notes) && typeof v.sheet_status === "string";
}

function parseResultText(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  let v = tryParse(s);
  if (v === undefined) {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
  }
  return v ?? null;
}

/**
 * Interpret Claude Code's stream-json output (already reduced to the init + result events).
 * Returns { ok:true, result, model } or { ok:false, error, retryable, kind }.
 */
export function interpretOutput({ init, result, stderr, code, timedOut, tooBig, spawnError }, timeoutMs) {
  const model = typeof init?.model === "string" ? init.model.slice(0, 100) : undefined;
  if (spawnError) {
    return { ok: false, retryable: true, kind: "spawn", error: `could not start Claude Code: ${redact(spawnError.message, 200)}` };
  }
  if (timedOut) return { ok: false, retryable: true, kind: "timeout", error: `Claude Code timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (tooBig) return { ok: false, retryable: true, kind: "output", error: "Claude Code output too large" };

  const resultText = typeof result?.result === "string" ? result.result : "";
  const diag = `${resultText}\n${stderr || ""}\n${result?.api_error_status ?? ""}`;

  if (!result || result.is_error || (result.subtype && result.subtype !== "success")) {
    if (AUTH_RE.test(diag)) return { ok: false, retryable: true, kind: "auth", error: `${AUTH_HELP} (${redact(diag.trim(), 200)})` };
    if (LIMIT_RE.test(diag)) return { ok: false, retryable: true, kind: "limit", error: `Claude usage/rate limit: ${redact(diag.trim(), 200)}` };
    const what = result ? `Claude Code error (${redact(result.subtype || "is_error", 40)})` : `no result from Claude Code (exit ${code})`;
    return { ok: false, retryable: true, kind: "error", error: `${what}: ${redact(diag.trim(), 300)}` };
  }

  let candidate = null;
  if (result.structured_output && typeof result.structured_output === "object") candidate = result.structured_output;
  else candidate = parseResultText(resultText);
  if (!looksLikePage(candidate)) {
    return { ok: false, retryable: true, kind: "invalid_output", error: `Claude returned output that is not a page extraction: ${redact(resultText || "(empty)", 200)}` };
  }
  return { ok: true, result: candidate, model };
}

export function validateTask(t) {
  if (!t || typeof t !== "object") return "task is not an object";
  if (typeof t.jobId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(t.jobId)) return "bad jobId";
  if (!Number.isInteger(t.page) || t.page < 0 || t.page > 100000) return "bad page";
  if (t.mediaType !== "image/png" && t.mediaType !== "image/jpeg") return "unsupported mediaType";
  if (typeof t.data !== "string" || t.data.length === 0 || t.data.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t.data)) return "bad image data";
  return null;
}

/** Run Claude Code on one task. Never throws. */
export async function extractPage(task, cfg, claude) {
  const started = Date.now();
  let cwd;
  try {
    await mkdir(cfg.workDir, { recursive: true });
    cwd = await mkdtemp(path.join(cfg.workDir, "task-"));
    let init = null;
    let result = null;
    const r = await runChild(claude, buildClaudeArgs(cfg.claudeModel), {
      stdin: buildStdinMessage(task),
      cwd,
      timeoutMs: cfg.taskTimeoutMs,
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev?.type === "system" && ev.subtype === "init") init = ev;
        else if (ev?.type === "result") result = ev;
      },
    });
    const out = interpretOutput({ init, result, ...r }, cfg.taskTimeoutMs);
    return { ...out, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, retryable: true, kind: "internal", error: `worker error: ${redact(e?.message, 200)}`, durationMs: Date.now() - started };
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// ───────────────────────────── HTTP ─────────────────────────────

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function headers(cfg, info) {
  return { authorization: `Bearer ${cfg.token}`, "x-worker-info": info, "user-agent": "panel-bom-worker" };
}

async function fetchNext(cfg, info, { probe = false } = {}) {
  const res = await fetch(`${cfg.workerUrl}/api/worker/next${probe ? "?probe=1" : ""}`, {
    method: "GET", headers: headers(cfg, info), signal: AbortSignal.timeout(30000), redirect: "error",
  });
  if (res.status === 204) { await res.body?.cancel(); return null; }
  if (res.status === 200) {
    const body = await res.json();
    // The server answers ?probe=1 with {ok:true} (auth + heartbeat only, nothing claimed).
    if (probe && body && body.ok === true && !body.jobId) return null;
    return { status: 200, task: body };
  }
  const body = redact(await res.text().catch(() => ""), 200);
  throw new HttpError(res.status, `GET /api/worker/next → ${res.status} ${body}`);
}

async function postResultOnce(cfg, info, body) {
  const res = await fetch(`${cfg.workerUrl}/api/worker/result`, {
    method: "POST",
    headers: { ...headers(cfg, info), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  const text = redact(await res.text().catch(() => ""), 200);
  return { status: res.status, text };
}

/** POST the result, retrying network errors / 5xx with backoff. Returns the final HTTP status or null. */
async function postResult(cfg, info, body, state) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const { status, text } = await postResultOnce(cfg, info, body);
      if (status >= 200 && status < 300) return status;
      if (status === 409) { log(`server ignored result for ${short(body)} (page no longer processing)`); return status; }
      if (status === 401 || status === 403) { warn(`server rejected WORKER_TOKEN (${status}) — check worker/.env`); return status; }
      if (status < 500 && status !== 429) { warn(`server refused result for ${short(body)}: ${status} ${text}`); return status; }
      warn(`POST result → ${status}, retrying in ${delay / 1000}s`);
    } catch (e) {
      warn(`POST result failed (${redact(e?.message, 120)}), retrying in ${delay / 1000}s`);
    }
    if (state?.hardStop) return null;
    await sleep(delay, state);
    delay = Math.min(delay * 2, 60000);
  }
  warn(`giving up posting result for ${short(body)}; the server will re-queue it after 10 min`);
  return null;
}

function short(t) { return `job ${String(t.jobId).slice(0, 8)} page ${t.page}`; }

// ───────────────────────────── main loop ─────────────────────────────

function sleep(ms, state) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); state?.wakers?.delete(done); resolve(); }
    state?.wakers?.add(done);
  });
}

async function claudeVersion(claude, cwd) {
  const r = await runChild(claude, ["--version"], { cwd, timeoutMs: 30000 });
  if (r.spawnError) throw new Error(`could not run Claude Code (${claude.display}): ${r.spawnError.message}`);
  const m = /\d+\.\d+\.\d+/.exec(r.stdout || "");
  return m ? m[0] : "unknown";
}

/** Verify the flags we rely on exist. Returns the missing ones. */
async function missingFlags(claude, cwd) {
  const r = await runChild(claude, ["--help"], { cwd, timeoutMs: 30000 });
  if (r.spawnError) throw new Error(`could not run Claude Code (${claude.display}): ${r.spawnError.message}`);
  const help = `${r.stdout}\n${r.stderr}`;
  const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/-/g, "\\-")}([\\s,=<\\[]|$)`, "m").test(help));
  if (!/stream-json/.test(help)) missing.push("stream-json format");
  return missing;
}

/** Shared startup: config, binary, flags, version. Throws with a user-facing message. */
export async function prepare(cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error(problems.join("\n"));
  SECRET_TOKEN = cfg.token;
  const claude = resolveClaude(cfg.claudeBin);
  await mkdir(cfg.workDir, { recursive: true });
  // Leftovers from a crash / hard kill. Only old ones, so a `--check` next to a running worker is harmless.
  const cutoff = Date.now() - cfg.taskTimeoutMs - 10 * 60 * 1000;
  for (const name of await readdir(cfg.workDir).catch(() => [])) {
    if (!/^(task|check)-/.test(name)) continue;
    const p = path.join(cfg.workDir, name);
    try { if (statSync(p).mtimeMs < cutoff) await rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const missing = await missingFlags(claude, cfg.workDir);
  if (missing.length) {
    throw new Error(`Your Claude Code is missing required options: ${missing.join(", ")}.\nUpdate it (\`claude update\` or \`npm i -g @anthropic-ai/claude-code@latest\`) and try again.`);
  }
  const version = await claudeVersion(claude, cfg.workDir);
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || "pc";
  return { claude, version, info: `${host} claude ${version}` };
}

/**
 * Claim at most one task, process it and post the result.
 * Returns { status: "idle" | "processed" | "http_error" | "invalid_task", outcome?, posted?, backoffMs? }.
 */
export async function runOnce(cfg, prep, state = { wakers: new Set() }) {
  prep = prep || (await prepare(cfg));
  let got;
  try {
    got = await fetchNext(cfg, prep.info);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      warn(`server rejected WORKER_TOKEN (${e.status}) — check worker/.env`);
      return { status: "http_error", httpStatus: e.status, backoffMs: 60000 };
    }
    warn(`poll failed: ${redact(e?.message, 200)}`);
    return { status: "http_error", httpStatus: e?.status, backoffMs: null };
  }
  if (!got) return { status: "idle" };

  const task = got.task;
  const bad = validateTask(task);
  if (bad) {
    warn(`received an invalid task (${bad})`);
    if (task && typeof task.jobId === "string" && Number.isInteger(task.page)) {
      const posted = await postResult(cfg, prep.info, { jobId: task.jobId, page: task.page, ok: false, error: `worker rejected task: ${bad}`, retryable: false }, state);
      return { status: "invalid_task", posted };
    }
    return { status: "invalid_task" };
  }

  const kb = Math.round((task.data.length * 3) / 4 / 1024);
  log(`→ ${short(task)} attempt ${task.attempt ?? "?"} (${task.mediaType}, ${kb} KB)`);
  state.current = (state.current || 0) + 1;
  const outcome = await extractPage(task, cfg, prep.claude);
  state.current--;

  let body;
  if (outcome.ok) {
    body = { jobId: task.jobId, page: task.page, ok: true, result: outcome.result, durationMs: outcome.durationMs };
    if (outcome.model) body.model = outcome.model;
    log(`✓ ${short(task)} in ${(outcome.durationMs / 1000).toFixed(1)}s — ${outcome.result.components.length} components`);
  } else {
    body = { jobId: task.jobId, page: task.page, ok: false, error: redact(outcome.error, 500), retryable: outcome.retryable };
    if (outcome.kind === "auth") {
      console.error("\n" + "!".repeat(72) + `\n!!  ${AUTH_HELP}\n` + "!".repeat(72) + "\n");
    }
    warn(`✗ ${short(task)}: ${body.error}`);
  }
  const posted = await postResult(cfg, prep.info, body, state);
  let backoffMs = 0;
  if (outcome.kind === "auth") backoffMs = 60000;
  else if (outcome.kind === "limit") backoffMs = 300000;
  return { status: "processed", outcome: { ...outcome, result: undefined }, posted, body, backoffMs };
}

async function slotLoop(id, cfg, prep, state) {
  let failDelay = 2000;
  while (!state.stopping) {
    const r = await runOnce(cfg, prep, state);
    if (state.stopping) break;
    if (r.status === "idle") { failDelay = 2000; await sleep(cfg.pollIntervalMs, state); continue; }
    if (r.status === "http_error") {
      const d = r.backoffMs ?? failDelay;
      if (r.backoffMs == null) failDelay = Math.min(failDelay * 2, 60000);
      await sleep(d, state);
      continue;
    }
    failDelay = 2000;
    if (r.backoffMs) { log(`[slot ${id}] backing off ${r.backoffMs / 1000}s`); await sleep(r.backoffMs, state); }
  }
}

async function runForever(cfg) {
  const prep = await prepare(cfg);
  log(`worker started: ${prep.info}; server ${cfg.workerUrl}; concurrency ${cfg.concurrency}; claude = ${prep.claude.display}${cfg.claudeModel ? `; model ${cfg.claudeModel}` : ""}`);
  const state = { stopping: false, hardStop: false, wakers: new Set(), current: 0 };
  const wakeAll = () => { for (const w of [...state.wakers]) w(); };
  const onSignal = (sig) => {
    if (!state.stopping) {
      state.stopping = true;
      log(`${sig} received — not taking new tasks; finishing ${state.current} in-flight task(s). Press Ctrl+C again to abort now.`);
      wakeAll();
      setTimeout(() => abort("grace period over"), 30000).unref();
    } else {
      abort(sig);
    }
  };
  const abort = (why) => {
    state.hardStop = true;
    log(`aborting (${why}); unfinished pages will be re-queued by the server after 10 min`);
    for (const c of liveChildren) killTree(c);
    wakeAll();
    setTimeout(() => process.exit(1), 2000).unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (process.platform === "win32") process.on("SIGBREAK", onSignal);
  await Promise.all(Array.from({ length: cfg.concurrency }, (_, i) => slotLoop(i + 1, cfg, prep, state)));
  log("worker stopped");
}

/** --check: config, flags, a trivial no-tools prompt (login check), and a non-claiming server probe. */
export async function selfCheck(cfg) {
  let ok = true;
  const step = (good, msg) => { console.log(`${good ? "  OK  " : " FAIL "} ${msg}`); if (!good) ok = false; };
  let prep;
  try {
    prep = await prepare(cfg);
    step(true, `config valid; Claude Code ${prep.version} at ${prep.claude.display}; all required flags present`);
  } catch (e) {
    step(false, e.message);
    return false;
  }

  await mkdir(cfg.workDir, { recursive: true });
  const dir = await mkdtemp(path.join(cfg.workDir, "check-"));
  try {
    let result = null;
    const args = ["-p", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence",
      "--output-format", "json", "--system-prompt", "Reply with exactly: OK"];
    if (cfg.claudeModel) args.push("--model", cfg.claudeModel);
    args.push("Reply with exactly: OK");
    const r = await runChild(prep.claude, args, { cwd: dir, timeoutMs: 120000 });
    try { result = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || "null"); } catch { /* handled below */ }
    const diag = `${result?.result ?? ""}\n${r.stderr}`;
    if (r.timedOut) step(false, "Claude Code test prompt timed out");
    else if (result && !result.is_error) step(true, `Claude Code is logged in and answered (${redact(result.result, 40)})`);
    else if (AUTH_RE.test(diag)) step(false, AUTH_HELP);
    else step(false, `Claude Code test prompt failed: ${redact(diag.trim() || `exit ${r.code}`, 300)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  try {
    const got = await fetchNext(cfg, prep.info, { probe: true });
    if (!got) step(true, `server ${cfg.workerUrl} accepted WORKER_TOKEN (probe)`);
    else {
      step(false, "server returned a task to the probe — it does not honour ?probe=1 yet. That page was claimed and will be re-queued after 10 min.");
    }
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) step(false, `server rejected WORKER_TOKEN (${e.status})`);
    else step(false, `cannot reach ${cfg.workerUrl}: ${redact(e?.message, 200)}`);
  }
  console.log(ok ? "\nAll checks passed. Start the worker with: node worker/worker.mjs" : "\nSome checks failed.");
  return ok;
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node worker/worker.mjs [--check | --once]\nConfig: worker/.env (see worker/.env.example and worker/README.md)");
    return 0;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) { console.error(`Node ${process.versions.node} is too old; install Node 20 or newer (22 recommended).`); return 1; }
  const cfg = loadConfig();
  try {
    if (argv.includes("--check")) return (await selfCheck(cfg)) ? 0 : 1;
    if (argv.includes("--once")) {
      const r = await runOnce(cfg);
      log(`--once: ${r.status}`);
      return r.status === "http_error" ? 1 : 0;
    }
    await runForever(cfg);
    return 0;
  } catch (e) {
    console.error(`\nworker cannot start:\n${redact(e?.message, 2000)}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
