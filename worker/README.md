# Panel BOM Pricer — local worker

The web app (Vercel) never calls an AI API itself. It queues page images; this worker, running 24/7 on the
owner's PC, picks them up, runs **Claude Code headless on your claude.ai subscription login** and sends the JSON
back. The PC only makes outbound HTTPS requests — nothing connects to it.

```
worker  ──GET  /api/worker/next   (Bearer WORKER_TOKEN)──▶  204 idle | 200 {jobId, page, mediaType, data}
worker  ──POST /api/worker/result {jobId, page, ok, result | error, retryable}──▶
```

Requirements: Node ≥ 20 (22 recommended), Claude Code (recent; the worker checks its flags at start-up), no npm
packages — `worker.mjs` uses Node built-ins only.

## Security model

Page images come from the internet and may contain text written to manipulate an AI ("ignore your instructions
and …"). The worker therefore runs Claude Code as a **pure function: image in → JSON out**.

* **No tools.** Command used for every page (all arguments are constants built by the worker):

  ```
  claude -p --tools "" --restricted --strict-mcp-config --no-session-persistence --verbose
         --input-format stream-json --output-format stream-json
         --json-schema <PAGE_JSON_SCHEMA> --system-prompt <SYSTEM_PROMPT> [--model $CLAUDE_MODEL]
  ```

  `--tools ""` removes every built-in tool, `--restricted` additionally ignores user/project settings files,
  `--strict-mcp-config` loads no MCP servers. Nothing in the drawing can make Claude run commands, read files or
  browse. (`--input-format stream-json` requires `--output-format stream-json`, which requires `--verbose`.)
  No `--dangerously-skip-permissions`, and not `--bare` (that would disable the subscription login).
* **Image only via stdin**, as a single stream-json user message. No task data ever appears in command-line
  arguments or file paths.
* **No shell.** Claude Code is spawned with `shell: false`. On Windows an npm install gives `claude.cmd` (a batch
  shim that would need `cmd.exe` and its quoting rules); the worker reads the shim, finds the real target
  (`cli.js` → run with this Node, or a native `claude.exe`) and spawns that directly. The native installer's
  `%USERPROFILE%\.local\bin\claude.exe` is used directly.
* **Sanitised environment.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `WORKER_TOKEN`
  are removed from the child's environment, so the subscription login is always used and the token never reaches
  Claude.
* **Throw-away working dir.** Each page runs in a fresh empty folder under `WORK_DIR` (default
  `<worker folder>/tmp`), also used as the child's TEMP; it is deleted afterwards. Per-page timeout
  (`TASK_TIMEOUT_MS`, default 8 min) kills the whole process tree.
* **Untrusted output.** The result is only `JSON.parse`d and shape-checked; the server validates it strictly.
  Nothing from it is executed.
* The token and image data are never logged.
* Recommended: run the worker under a **separate, low-privilege OS user** that has its own Claude Code login and
  no access to your documents.

## Setup — Windows (10/11)

Recommended location: `R:\panel-bom-worker` (keeps scratch files off a small C: drive).

1. Install **Node 22** (https://nodejs.org) and **Claude Code** (native installer, or
   `npm install -g @anthropic-ai/claude-code`). Open a new PowerShell window and run `claude` once; log in with
   the claude.ai account, then `/exit`.
2. Copy the contents of this `worker` folder to `R:\panel-bom-worker`.
3. In that folder: `copy .env.example .env`, open `.env` in Notepad and paste `WORKER_TOKEN` (same value as in
   Vercel). Leave `CLAUDE_BIN` empty unless Claude Code is not found automatically.
4. Self-test:

   ```powershell
   cd R:\panel-bom-worker
   node worker.mjs --check
   ```

   It verifies the config, the Claude Code flags, that Claude Code is logged in (one tiny no-tools prompt), and
   that the server accepts the token — **without claiming a page** (see "Server requirement" below).
5. Run it 24/7 with the Scheduled Task "PanelBomWorker":

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
   ```

   The task starts at logon of the current user, has no time limit, runs on battery, restarts on failure every
   1 min (up to 999 times), and ignores a second instance. It runs `run-worker.cmd`, which also restarts the worker
   60 s after any exit and appends output to `logs\worker.log`
   (`Get-Content R:\panel-bom-worker\logs\worker.log -Wait -Tail 20`). A console window titled `PanelBomWorker`
   stays open — minimise it, don't close it.
   Variant without a window that also runs before anyone logs on: from an **elevated** PowerShell run
   `.\install-task.ps1 -Hidden` (uses "run whether user is logged on or not", S4U, at startup).
   Remove with `.\uninstall-task.ps1`. Only the task named `PanelBomWorker` is touched.

   Alternative: `npm i -g pm2 && pm2 start worker.mjs --name panel-bom-worker && pm2 save` (plus
   `pm2-windows-startup` or similar for boot).

## Setup — Linux / macOS

```bash
# Node 22 + Claude Code, then log in once:
npm install -g @anthropic-ai/claude-code   # or the native installer
claude                                     # log in with the claude.ai account, then /exit
cd /opt/panel-bom-worker                   # a copy of this folder
cp .env.example .env && chmod 600 .env     # paste WORKER_TOKEN
node worker.mjs --check
```

**systemd user service** (`~/.config/systemd/user/panel-bom-worker.service`):

```ini
[Unit]
Description=Panel BOM Pricer worker
After=network-online.target

[Service]
WorkingDirectory=/opt/panel-bom-worker
ExecStart=/usr/bin/node /opt/panel-bom-worker/worker.mjs
Restart=always
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=60
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now panel-bom-worker
loginctl enable-linger "$USER"     # keep running when logged out
journalctl --user -u panel-bom-worker -f
```

Make sure `claude` is on the service's PATH (or set `CLAUDE_BIN=/full/path/to/claude` in `.env`).

**macOS**: use a launchd agent (`~/Library/LaunchAgents/com.panelbom.worker.plist`) with `ProgramArguments`
`/usr/local/bin/node /path/worker.mjs`, `WorkingDirectory`, `RunAtLoad` and `KeepAlive` set to true, then
`launchctl load ~/Library/LaunchAgents/com.panelbom.worker.plist`. Or `pm2`.

## Configuration (`.env`, real environment variables override it)

| Name | Default | Purpose |
|---|---|---|
| `WORKER_URL` | — | App URL, e.g. `https://panel-bom-pricer.vercel.app` (must be https, except localhost) |
| `WORKER_TOKEN` | — | Shared secret, same as on Vercel |
| `CLAUDE_BIN` | auto | Claude Code command. May include leading args, quoted if needed: `node /path/cli.js`, `"C:\Program Files\nodejs\node.exe" "C:\…\cli.js"` |
| `CLAUDE_MODEL` | Claude Code default | Passed as `--model` |
| `POLL_INTERVAL_MS` | 5000 | Idle poll interval |
| `TASK_TIMEOUT_MS` | 480000 | Per-page timeout |
| `CONCURRENCY` | 1 | Pages in parallel (max 3) |
| `WORK_DIR` | `<worker folder>/tmp` | Per-page scratch folders |

## Behaviour

* `204` → sleep `POLL_INTERVAL_MS`. Network errors / 5xx → exponential backoff up to 60 s; never crashes.
* `401/403` → "server rejected WORKER_TOKEN", retry every 60 s.
* Claude not logged in → big console warning *"Claude Code is not logged in — run `claude` once and log in"*,
  the page is reported `ok:false, retryable:true`, 60 s pause. Usage/rate limit → 5 min pause.
* Invalid/unparseable output or timeout → `ok:false, retryable:true` (the server retries up to 3 attempts).
* Ctrl+C / SIGTERM: stop taking new pages, finish the current one (max 30 s); a second Ctrl+C aborts. Abandoned
  pages are re-queued by the server after 10 min.
* `--once`: claim at most one page, process it, exit (handy for testing).

## Server requirement: `?probe=1`

`--check` calls `GET /api/worker/next?probe=1`. The server must treat `probe=1` as **auth check + heartbeat
only** (never claim a page) and answer `204` (or `401` for a bad token). If an old server ignores the parameter
and returns a task, `--check` reports it; that page is re-queued after 10 min.

## Tests

`worker/fake-claude.mjs` is a stand-in `claude` CLI used by `tests/worker.test.ts`
(`FAKE_CLAUDE_MODE=ok|garbage|notloggedin|slow|fenced`). Run `npx vitest run tests/worker.test.ts`.
