# One-shot setup prompt for the worker PC

Paste the block below into Claude Code on the Windows PC. Replace `<WORKER_TOKEN>` with the value from Vercel
first (Project → Settings → Environment Variables → WORKER_TOKEN). **Never commit the real token.**

```text
Set up the "Panel BOM Pricer" worker on this Windows PC so it runs 24/7 using THIS Claude Code login. Work step by step and stop to ask me if anything is unclear or would affect other apps.

Context
- Repo: https://github.com/Arun270647/cad-report (branch ccr-4c034b81-478sid). Only its worker\ folder is needed on this PC.
- The website https://panel-bom-pricer.vercel.app queues drawing-page images; this worker polls it over outbound HTTPS, reads each image with Claude Code (headless, no tools) on my claude.ai subscription, and posts JSON back. Nothing connects in to this PC.
- This PC already runs another app at R:\motiv-shorts with its own scheduled tasks and Telegram setup. Do NOT modify, stop or re-register anything belonging to motiv-shorts.
- Windows 10 Pro, PowerShell 5.1 (no PowerShell 7 syntax). Drive C: has little free space, so put everything on R:.
- Worker settings:
    WORKER_URL=https://panel-bom-pricer.vercel.app
    WORKER_TOKEN=<WORKER_TOKEN>
  Treat WORKER_TOKEN as a secret: write it only into R:\panel-bom-worker\.env and never echo it in logs or summaries.

Steps
1. Prerequisites: check `node -v` (needs 20+; if missing or older, tell me and stop) and `claude --version`. Run `claude update` if available. Confirm Claude Code is logged in with my claude.ai account (not an API key): if ANTHROPIC_API_KEY is set in my user or system environment, tell me, because the worker strips it but I should know.
2. Download the repo as a zip (no git needed):
   https://github.com/Arun270647/cad-report/archive/refs/heads/ccr-4c034b81-478sid.zip
   into R:\panel-bom-worker-src (Invoke-WebRequest + Expand-Archive). If the download fails with 404, the repo is still private: tell me to make it public or to sign in to GitHub, then stop.
3. Create R:\panel-bom-worker and copy the CONTENTS of the extracted worker\ folder into it (worker.mjs, prompt.mjs, run-worker.cmd, install-task.ps1, uninstall-task.ps1, .env.example, README.md and the rest). Read README.md there before continuing and follow it where it differs from these steps.
4. Create R:\panel-bom-worker\.env from .env.example with WORKER_URL and WORKER_TOKEN above. Leave CLAUDE_BIN empty unless the next step says Claude Code cannot be found (then set it to the full path of claude.exe).
5. In R:\panel-bom-worker run: `node worker.mjs --check`. Every step must be OK: config and flags, Claude Code logged in, and the server accepting the token via the probe. Fix any failure (e.g. `claude update` for missing flags, `claude` then /login if not logged in), then re-run until all pass.
6. Process one real job as a smoke test: run `node worker.mjs --once` and tell me to upload a drawing at https://panel-bom-pricer.vercel.app (or report "idle" if the queue is empty, which is fine).
7. Install it to run 24/7 with Task Scheduler. First look at how the motiv-shorts tasks are registered (Get-ScheduledTask | Where TaskPath/TaskName mentions motiv, and their principal/triggers) and mirror the same style so it survives reboots the same way, for example at logon of my user, or at startup with -Hidden from an elevated PowerShell. Then run
     powershell -ExecutionPolicy Bypass -File R:\panel-bom-worker\install-task.ps1   (add -Hidden if mirroring a run-whether-logged-on task; that needs an admin shell)
   The task must be named "PanelBomWorker". Do not touch other tasks.
8. Verify: Get-ScheduledTask -TaskName PanelBomWorker shows Running, and R:\panel-bom-worker\logs\worker.log shows "worker started" with no repeating errors. Then run `curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer <token from .env>" "https://panel-bom-pricer.vercel.app/api/worker/next?probe=1"` (read the token from .env inside the command, do not print it); it must return 200.
9. Delete R:\panel-bom-worker-src. Give me a short summary: install path, Node and Claude Code versions, how the task is triggered, where logs are, and how to stop or uninstall it (uninstall-task.ps1). Do not include the token.
```
