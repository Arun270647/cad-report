#!/usr/bin/env node
// Panel BOM Pricer — worker supervisor.
//
// Keeps worker.mjs running 24/7:
//   * restarts it after any exit, with exponential backoff (5 s → 10 s → … → 5 min; reset after 10 min of uptime)
//   * writes its output to logs/worker-YYYY-MM-DD.log (a new file every day, local date) and deletes logs older than
//     LOG_KEEP_DAYS (default 14)
//   * refuses to start twice (logs/supervisor.pid)
//
//   node worker/supervisor.mjs          (what the scheduled task runs; see install-task.ps1)
//
// Node >= 20, no npm dependencies.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const PID_FILE = path.join(LOG_DIR, "supervisor.pid");
const WORKER = path.join(HERE, "worker.mjs");
const KEEP_DAYS = Math.max(1, Number.parseInt(process.env.LOG_KEEP_DAYS || "14", 10) || 14);
const MIN_DELAY = 5_000;
const MAX_DELAY = 5 * 60_000;
const STABLE_MS = 10 * 60_000;
const IS_WIN = process.platform === "win32";

mkdirSync(LOG_DIR, { recursive: true });

const pad = (n) => String(n).padStart(2, "0");
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function logFileFor(d = new Date()) {
  return path.join(LOG_DIR, `worker-${localDate(d)}.log`);
}

let lastDay = "";
function write(text) {
  const day = localDate();
  if (day !== lastDay) {
    lastDay = day;
    prune();
  }
  try {
    appendFileSync(logFileFor(), text);
  } catch {
    /* disk full / locked: nothing sensible to do */
  }
}
const say = (msg) => write(`${new Date().toISOString()} [supervisor] ${msg}\n`);

/** Delete worker-YYYY-MM-DD.log files older than KEEP_DAYS. */
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600_000;
  for (const name of readdirSync(LOG_DIR)) {
    if (!/^worker-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const p = path.join(LOG_DIR, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** True when another live supervisor already owns this folder. */
function anotherInstance() {
  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, "utf8"), 10);
  } catch {
    return false;
  }
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // throws if no such process
  } catch {
    return false;
  }
  if (!IS_WIN) return true;
  // PIDs are reused on Windows: only count it if that PID is node running this supervisor.
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return /supervisor\.mjs/i.test(r.stdout || "");
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

function main() {
  if (anotherInstance()) {
    say(`another supervisor is already running (pid file ${PID_FILE}); exiting`);
    process.exitCode = 0;
    return;
  }
  writeFileSync(PID_FILE, String(process.pid));

  let child = null;
  let stopping = false;
  let delay = MIN_DELAY;
  let timer = null;

  const start = () => {
    timer = null;
    if (stopping) return;
    const startedAt = Date.now();
    say(`starting worker (node ${process.version})`);
    child = spawn(process.execPath, [WORKER], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (b) => write(b.toString("utf8")));
    child.stderr.on("data", (b) => write(b.toString("utf8")));
    child.on("error", (e) => say(`could not start worker: ${e.message}`));
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return;
      const up = Date.now() - startedAt;
      delay = up >= STABLE_MS ? MIN_DELAY : Math.min(MAX_DELAY, Math.max(MIN_DELAY, delay * (up < 60_000 ? 2 : 1)));
      say(`worker exited (${signal ?? `code ${code}`}) after ${Math.round(up / 1000)} s; restarting in ${Math.round(delay / 1000)} s`);
      timer = setTimeout(start, delay);
    });
  };

  const stop = (why) => {
    if (stopping) return;
    stopping = true;
    say(`stopping (${why})`);
    if (timer) clearTimeout(timer);
    killTree(child);
    try {
      if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  if (IS_WIN) process.on("SIGBREAK", () => stop("SIGBREAK"));
  process.on("exit", () => killTree(child));

  say(`supervisor started (pid ${process.pid}); logs: ${LOG_DIR} (kept ${KEEP_DAYS} days)`);
  start();
}

main();
