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

## Database (Postgres, schema `bom`, created via migration — the app does NOT run migrations)

```sql
bom.jobs (id uuid pk default gen_random_uuid(), email text not null, filename text not null,
          status text not null default 'uploading', page_count int not null,
          created_at timestamptz default now(), updated_at timestamptz default now())
bom.job_pages (job_id uuid references bom.jobs(id) on delete cascade, page int, primary key (job_id, page),
          status text not null,            -- skipped | awaiting_upload | pending | processing | done | error
          skip_reason text, media_type text, image bytea, result jsonb, error text,
          attempts int not null default 0, claimed_at timestamptz, updated_at timestamptz default now())
bom.worker_heartbeat (id int pk default 1, last_seen timestamptz, info text)
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
  Job status: `uploading` until every non-skipped page is uploaded, then `queued`; `processing` once any page is claimed;
  `done` when no page is awaiting_upload/pending/processing.
* **Worker queue**: `GET /api/worker/next` updates the heartbeat, releases stale claims (processing for > 10 min → pending,
  or → error "timed out" after 3 attempts), then atomically claims the oldest pending page
  (`FOR UPDATE SKIP LOCKED`, attempts + 1) and returns a `WorkerTask`, or `204` when idle.
  `POST /api/worker/result`: ok → validate `result` with `PageZod`; invalid → treat as a retryable error.
  Retryable errors go back to `pending` until attempts ≥ 3, then `error`. Results for pages that are not `processing` are ignored (409).
* **Status**: `GET /api/status` (session required) → `StatusView`.
* Types for all request/response bodies are in `src/lib/contract.ts`; the page JSON schema + validator in `src/lib/bom/page-schema.ts`.
