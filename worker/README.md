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

1. Install **Node 20+ machine-wide** (the nodejs.org installer → `C:\Program Files\nodejs`; Node 24 is in use) and
   **Claude Code** (native installer, or `npm install -g @anthropic-ai/claude-code`). Avoid per-user Node installs
   such as nvm that live in another user's profile — the task would break when that user changes versions.
   Open a new PowerShell window and run `claude` once; log in with the claude.ai account, then `/exit`.
2. Copy the contents of this `worker` folder to `R:\panel-bom-worker`.
3. In that folder: `copy .env.example .env`, open `.env` in Notepad and paste `WORKER_TOKEN` (same value as in
   Vercel). Leave `CLAUDE_BIN` empty unless Claude Code is not found automatically.
4. Self-test:

   ```powershell
   cd R:\panel-bom-worker
   node worker.mjs --check
   ```

   It verifies the config, the Claude Code flags, that Claude Code is logged in (one tiny no-tools prompt and
   `claude auth status`), that the server accepts the token — **without claiming a page** (see "Server requirement"
   below) — and that the server accepts a heartbeat.
5. Run it 24/7 with the Scheduled Task "PanelBomWorker" (uses `C:\Program Files\nodejs\node.exe` when present):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
   ```

   **At logon of the current user, no window.** The task runs `wscript launch-hidden.vbs`, which starts
   `supervisor.mjs` with no console window. No admin needed. It does not run while that user is signed out.

   **At boot, whether or not anyone is logged on** (needs an administrator): from an **elevated** PowerShell,
   register it for the account that holds the Claude Code login (S4U: no stored password, no window):

   ```powershell
   powershell -ExecutionPolicy Bypass -File R:\panel-bom-worker\install-task.ps1 -Hidden -User "PC-NAME\user"
   ```

   Both variants: no time limit, run on battery, Task Scheduler restarts the task every 1 min on failure (up to
   999 times), a second instance is ignored. Re-running the script replaces the task and stops this folder's old
   worker processes (including the old `run-worker.cmd` loop). Only the task named `PanelBomWorker` and processes
   running this folder's worker are touched.

   **Supervisor** (`supervisor.mjs`): restarts `worker.mjs` after any exit with exponential backoff
   (10 s, 20 s, … up to 5 min; back to 5 s once it has run for 10 min) and writes all output to
   **`logs\worker-YYYY-MM-DD.log`** — a new file every day, files older than 14 days (`LOG_KEEP_DAYS`) are deleted.
   Follow today's log: `Get-Content R:\panel-bom-worker\logs\worker-$(Get-Date -f yyyy-MM-dd).log -Wait -Tail 20`.
   `run-worker.cmd` runs the same supervisor in a console window by hand.

   Stop: `Stop-ScheduledTask PanelBomWorker` then `.\uninstall-task.ps1` (removes the task and ends the processes).
   To pause conversions without stopping the PC worker, use **Pause** on the admin Worker page.

6. **Keep the PC awake.** The worker can only poll while Windows is running. On mains power set sleep and hibernate
   to *Never* (Settings → System → Power & sleep, or from PowerShell):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   # laptops only — keep working with the lid closed on mains power:
   powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
   powercfg /setactive SCHEME_CURRENT
   ```

   Check with `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` ("Current AC Power Setting Index: 0x00000000"
   = never). The current worker PC (a desktop on the Balanced plan) already has AC sleep and hibernate set to never.
   Also keep Windows Update's active hours / restart options so it does not reboot into a signed-out state
   (with the at-logon task the worker only resumes after the user signs in again).

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
| `WORK_DIR` | `<worker folder>/tmp` | Per-page scratch folders |
| `LOG_KEEP_DAYS` | 14 | Supervisor: days of `logs\worker-YYYY-MM-DD.log` to keep |

Pages are always processed **one at a time** (the old `CONCURRENCY` setting is ignored); the server enforces the
same, so parallel uploads queue up instead of hitting plan limits together.

## Behaviour

* `204` → sleep `POLL_INTERVAL_MS` (also while an admin has paused conversions or a usage limit is active).
  Network errors / 5xx → exponential backoff up to 60 s; never crashes.
* `401/403` → "server rejected WORKER_TOKEN", retry every 60 s.
* **Heartbeat** every 60 s (`POST /api/worker/heartbeat`): Node and Claude Code versions, whether the claude.ai login
  is still valid (`claude auth status` every 5 min — no model call, no plan usage), last poll, last error, limit state.
  The admin Worker page shows Online / Degraded / Offline from it.
* Claude not logged in → big log warning *"Claude Code is not logged in — run `claude` once and log in"*, the page
  goes back to the queue **without using up an attempt**, 60 s pause, and the admin page shows "logged out".
* **Plan usage limit** (Claude Code says e.g. "usage limit reached … resets 3pm") → the reset time is parsed, the page
  is reported `kind: "usage_limit"` and shown to the user as **"Waiting – usage limit"** (not failed, attempt not
  counted); the worker and the server hold the whole queue until the reset and then continue automatically.
  Short transient limits (429 / overloaded) → 5 min pause and a normal retry.
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
(`FAKE_CLAUDE_MODE=ok|garbage|notloggedin|usagelimit|slow|fenced`). Run `npx vitest run tests/worker.test.ts`.
