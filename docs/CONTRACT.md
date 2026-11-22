# Panel BOM Pricer — architecture contract

```
Browser (allowed email only)          Vercel (Next.js)                       Your PC (24/7)
───────────────────────────           ─────────────────                      ──────────────
login: POST /api/session  ───────────▶ sets signed HttpOnly cookie
render PDF pages → PNG (pdf.js)
POST /api/jobs            ───────────▶ creates job + page rows
POST /api/jobs/:id/pages/:n ─────────▶ stores page image (bytea)  ◀──────── GET  /api/worker/next  (poll, Bearer WORKER_TOKEN)
GET  /api/jobs/:id  (poll every 3s) ─▶ page statuses + results    ◀──────── POST /api/worker/result (validated with zod)
when all pages done: aggregate → match → Excel IN THE BROWSER        worker runs: claude -p --tools "" --restricted ... (no tools)
```

The PC never accepts inbound connections and never parses PDFs (it only receives PNG/JPEG images).
Claude Code on the PC is invoked as a pure function: image in → JSON out, **no tools at all**, so text hidden
inside a drawing (prompt injection) cannot run commands, read files or reach the network.

## Environment variables (Vercel)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Supabase pooler URL (role `bom_app`, schema `bom`). Already set. |
| `ALLOWED_EMAILS` | Comma-separated list of emails allowed in (case-insensitive). |
| `SESSION_SECRET` | ≥ 32 random chars; HMAC key for the session cookie. |
| `WORKER_TOKEN` | ≥ 32 random chars; shared secret the PC worker sends as `Authorization: Bearer …`. |
| `ADMIN_EMAILS` | Comma-separated subset of `ALLOWED_EMAILS` who may open `/admin` (worker status, pause/resume). Empty = nobody. |
| `CRON_SECRET` | ≥ 16 random chars; `.github/workflows/worker-check.yml` sends it to `/api/cron/worker-check` (also a GitHub repo secret). |

There is no AI API key anywhere in the web app: extraction runs only on the PC through Claude Code's claude.ai login.

## Database (Postgres, schema `bom`, created via migration — the app does NOT run migrations)

Migrations live in `db/migrations/` and are applied by the schema owner (`002_worker_monitoring.sql` adds the columns
and tables marked *(002)* below).

```sql
bom.jobs (id uuid pk default gen_random_uuid(), email text not null, filename text not null,
          status text not null default 'uploading', page_count int not null,
          created_at timestamptz default now(), updated_at timestamptz default now())
bom.job_pages (job_id uuid references bom.jobs(id) on delete cascade, page int, primary key (job_id, page),
          status text not null,            -- skipped | awaiting_upload | pending | processing | waiting_limit | done | error
          skip_reason text, media_type text, image bytea, result jsonb, error text,
          attempts int not null default 0, claimed_at timestamptz, updated_at timestamptz default now(),
          retry_at timestamptz, duration_ms int, finished_at timestamptz)                         -- (002)
bom.worker_heartbeat (id int pk default 1, last_seen timestamptz, info text,
          node_version text, claude_version text, login_ok boolean, login_detail text,          -- (002)
          last_poll timestamptz, last_error text, limit_until timestamptz, started_at timestamptz)
bom.settings (id int pk = 1, paused boolean, paused_by text, paused_at timestamptz)              -- (002)
bom.worker_alerts (id bigserial pk, kind text, message text, opened_at, resolved_at, notified_at) -- (002), ≤ 1 open per kind
bom.login_attempts (id bigserial pk, ip text not null, at timestamptz default now(), ok boolean not null)
```

## Rules

* **Session**: cookie `pbp_session` = `base64url(email).base64url(expiryMs).base64url(HMAC-SHA256(SESSION_SECRET, email + "." + expiryMs))`,
  HttpOnly, Secure (in production), SameSite=Lax, Path=/, 30 days. Verified in `src/middleware.ts` (Web Crypto) AND in every
  `/api/jobs*` handler (Node crypto) — the email must still be in `ALLOWED_EMAILS` at verification time.
* **Login**: `POST /api/session {email}` → 200 + cookie if allowed, 401 otherwise. Max 10 failed attempts per IP per 15 min (429).
  Constant-time comparison. `DELETE /api/session` clears the cookie. Unauthenticated page requests redirect to `/login`;
  unauthenticated API requests get 401 JSON.
* **Jobs**: a user only sees jobs whose `email` equals their session email. Job IDs are UUIDs. Page images are deleted
  (`image = null`) as soon as a result is stored. Jobs older than 7 days are deleted opportunistically on `POST /api/jobs`.
  Limits: ≤ 200 pages per job, image base64 ≤ 4,000,000 chars, ≤ 20 jobs per email per hour.
  Job status: `uploading` until every non-skipped page is uploaded, then `queued`; `processing` while a page is read
  (or once any page has been claimed); `waiting_limit` when the only unfinished pages wait for a Claude usage-limit reset;
  `done` when no page is awaiting_upload/pending/processing/waiting_limit.
* **Worker queue**: `GET /api/worker/next` updates the heartbeat/last poll; answers `204` while conversions are paused
  (`x-worker-paused: 1`) or a usage limit is active (`x-worker-limit-until`); releases stale claims (processing for > 10 min
  → pending, or → error "timed out" after 3 attempts); then — under a transaction advisory lock and only when NO page is
  `processing` — claims the next page: oldest job first, then page order, `pending` or `waiting_limit` whose `retry_at` has
  passed (attempts + 1). One page at a time, system-wide.
  `POST /api/worker/result`: ok → validate `result` with `PageZod` (invalid → retryable error), store `duration_ms`.
  `kind: "usage_limit"` → `waiting_limit` until `retryAt` (clamped to 1 min … 8 days, default 30 min), attempt not counted,
  queue held until then. `kind: "auth"` → back to `pending`, attempt not counted (worker logged out).
  Other retryable errors go back to `pending` until attempts ≥ 3, then `error`. Results for pages that are not `processing` are ignored (409).
* **Heartbeat**: `POST /api/worker/heartbeat` every 60 s (`WorkerHeartbeatRequest`: Node/Claude Code versions, claude.ai login
  validity from `claude auth status`, limit, last poll/error) → `{ok, paused}`. Opens/resolves `logout` and `usage_limit` alerts.
* **Worker state** (`computeWorkerState`): offline = no heartbeat for 5 min; degraded = heartbeat late (> 150 s), logged out,
  or usage limit active; otherwise online.
* **Alerts**: `offline` is opened by `GET /api/cron/worker-check` (Bearer `CRON_SECRET`, every 5 min from GitHub Actions) and
  resolved by the next heartbeat. Shown on `/admin`; email delivery is not configured (hook: `notify()` in `worker-status.ts`).
* **Admin**: `/admin` page; `GET /api/admin/worker` → `AdminWorkerView` (state, versions, login, queue, last 20 jobs with
  durations/errors, alerts); `POST /api/admin/worker {action: "pause" | "resume"}`. Session + `ADMIN_EMAILS` required (403 otherwise).
* **Status**: `GET /api/status` (session required) → `StatusView` (worker state, paused, limitUntil, isAdmin).
* Types for all request/response bodies are in `src/lib/contract.ts`; the page JSON schema + validator in `src/lib/bom/page-schema.ts`.
