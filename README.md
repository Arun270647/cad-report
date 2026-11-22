# Panel BOM Pricer

Drag in an electrical control-panel drawing PDF and get back a priced Bill of Materials in Excel, grouped by MAKE.

* **Restricted access:** only the email addresses in `ALLOWED_EMAILS` can open the site. The site asks for the email first.
* **Drawings are read by Claude Code on your own PC.** It runs on your claude.ai login, so there is **no API key and no API bill**. The PC polls the website for work over outbound HTTPS and never accepts inbound connections.
* **Matching, pricing and Excel run in your browser.** The price list never leaves your machine.

```
Browser (allowed email)                Vercel (this app)                    Your Windows PC (24/7)
renders PDF pages → PNG   ── upload ──▶ job queue in Postgres  ◀── polls ── worker/worker.mjs
polls job status          ◀─────────── results (validated)     ◀── posts ── claude -p --tools "" (no tools)
builds the Excel locally
```

## Using it

1. Open the site and enter your email.
2. Drop your **price list (.xlsx)**. You only do this once, because the browser remembers it.
3. Drop the **drawing PDF**, adjust the margin if needed (12.5% by default), and click **Convert**.
4. Watch the progress. RESERVED and blank sheets are skipped in the browser. The other sheets show *uploading*, then *waiting in queue*, then *reading on PC*, then *done*. The pill at the top shows whether your PC worker is online. If it is offline, jobs wait in the queue until it comes back. If you close the tab, the job resumes when you reopen it.
5. Click **Download …_BOM.xlsx**.

### The price list

The first sheet needs a header row with these columns: `TEREX P/N, WHERE USED, DRG SHEET NO, DESCRIPTION, MANUFACTURE P/N, MAKE, UOM, QTY, LIST PRICE, Disc, Unit price, Margin, Terex Unit price, Total Price, TAG NO`.

**Matching rules are optional.** Add a sheet whose name contains `RULES`, with the columns `Device type | Rating | Qualifier | Manufacturer P/N` (e.g. `MPCB | 13-18A | | GV2ME20`, `PILOT_LAMP | - | GREEN | XB7NV63`). `samples/sample-price-file.xlsx` shows the format.

### What the Excel contains

* Columns A–N with **live formulas**: `K = I-(I*J)`, `M = K+(K*L)`, `N = H*M`.
* **Grouped by MAKE:** makes alphabetical, with REPUTED, LABOUR, NON-STOCK and unspecified last. Each make has a header, its items and a `SUBTOTAL`. The `GRAND TOTAL` is the sum of the subtotals, followed by a summary table: Make | Line count | Subtotal | % of total.
* Calibri 10, thin borders, yellow header row, % formats, thousand separators.
* **Never a guessed price:** with no exact rating match the price stays blank (yellow cell). With conflicting price rows, the row with a Terex P/N is used and the alternatives go into the cell comment.
* The page also shows device counts (lamps by colour, pushbuttons by function, relays by type, terminals per block) and drawing anomalies (duplicate tags, terminal clashes, protection below motor FLC).

## Setting up the PC worker (one time)

See **[worker/README.md](worker/README.md)**. In short, on the Windows PC:

1. Copy the `worker` folder to `R:\panel-bom-worker`.
2. Copy `.env.example` to `.env` and set `WORKER_URL=https://panel-bom-pricer.vercel.app` and `WORKER_TOKEN=<the token in Vercel>`.
3. Run `node worker.mjs --check`. It verifies Claude Code is logged in and can reach the site.
4. Run `powershell -ExecutionPolicy Bypass -File install-task.ps1` to keep it running 24/7 through Task Scheduler.

### Why this is safe to run on your PC

Drawings come from the website and could contain hidden prompt-injection text. The worker therefore runs Claude Code as a pure "image in → JSON out" function:

* `--tools ""` (no tools at all), `--restricted`, `--strict-mcp-config`, no session persistence;
* a fresh empty temporary folder for each task, in a sanitised environment (no API keys, no worker token);
* the PC never parses PDFs (it only receives PNG/JPEG images);
* the output is validated against a strict schema on the server before anyone sees it.

## Vercel environment variables

| Variable | Purpose |
|---|---|
| `ALLOWED_EMAILS` | Comma-separated emails allowed to sign in. |
| `SESSION_SECRET` | Random string (≥ 32 chars) that signs the login cookie. |
| `WORKER_TOKEN` | Random string (≥ 32 chars) shared with the PC worker. |
| `DATABASE_URL` | Postgres (Supabase pooler, role `bom_app`, schema `bom`). Tables are in `docs/CONTRACT.md`. |

Email-only sign-in means that anyone who knows an allowed email can get in. Failed attempts are rate-limited (10 per 15 minutes per IP).

## Development

```bash
npm install
npm test               # 42 tests: matching/Excel end-to-end, server logic, worker (with a fake claude CLI)
npm run dev
npm run seed:samples   # regenerate samples/
```

Key files: `docs/CONTRACT.md` (architecture and API), `src/app/page.tsx` (UI), `src/app/api/**` (session, jobs, worker endpoints), `src/lib/bom/**` (matching and Excel), `worker/worker.mjs` (PC worker).
