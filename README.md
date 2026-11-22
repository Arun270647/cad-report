# Panel BOM Pricer

Panel BOM Pricer turns electrical control-panel drawing PDFs into a priced Bill of Materials (BOM). The Claude API (vision) reads each drawing sheet. Plain code, with no AI, matches the extracted parts against your consolidated price file. A reviewer then checks and approves the BOM, and the app exports an Excel workbook in your template format with live formulas, grouped by MAKE.

**Stack:** Next.js 15 (App Router, TypeScript) · Tailwind CSS v4 + shadcn/ui-style components · PostgreSQL (Supabase) via Drizzle ORM · NextAuth (Auth.js v4) email/password with ADMIN and USER roles · ExcelJS · pdf.js + @napi-rs/canvas for page rendering · `@anthropic-ai/sdk` (server-side only) · Vercel (hosting and Cron).

---

## How it works

```
PDF upload (in 3 MB chunks)
  → Rendering pages   pdf.js text layer: RESERVED sheets are skipped; each page is rendered to PNG; blank pages are skipped
  → Extracting        one Claude call per sheet with structured JSON output, with retry/backoff; every call is logged
  → Matching          deterministic: device type + exact rating → rules → price rows (Terex P/N preferred)
  → Review            editable table with status chips, conflict resolution, add/remove lines, validation, approve
  → Export            .xlsx in the template layout, grouped by MAKE, with live formulas
```

The browser drives the pipeline one step per request (`POST /api/jobs/:id/step`). Each serverless call therefore stays well within Vercel's time limit, and the progress view updates after every sheet.

### Business rules implemented

* **Group by MAKE everywhere** (on screen and in Excel). Makes are listed alphabetically. Generic entries (REPUTED, LABOUR, NON‑STOCK, blank) come last. Each make gets a header row, its items and a `SUBTOTAL` row (`=SUM(N…)`). The `GRAND TOTAL` is the sum of the subtotal cells. A summary table follows: Make | Line count | Subtotal | % of total.
* **Formulas:** `K = I-(I*J)`, `M = K+(K*L)`, `N = H*M`. Calibri 10, thin borders, yellow header row, discount and margin as %, prices as `#,##0.00`. Unpriced cells are filled yellow, and notes become cell comments.
* **Matching never substitutes a different rating.** If there is no exact match, the price stays blank and the line is flagged **Not in price list**. When several price rows match with different prices, the line is flagged **Conflict**: the row with a Terex P/N is preselected and the alternatives are stored. Export stays blocked until every conflict is resolved.
* **Drawing anomalies are flagged:** a tag reused for different devices, terminal numbers used twice in the same terminal block, and protection settings below the motor FLC.
* **Counts:** pilot lamps by colour, pushbuttons by function, relays by type (2C/O vs 4C/O, AC vs DC coil) and terminals per terminal block.
* **Validation before approval/export:** the grand total equals the sum of the subtotals, no formula errors, every line has a MAKE and a UOM, no unresolved conflicts, and quantity totals match the extracted device counts. A quantity mismatch can be acknowledged explicitly.

### Security

* The Claude API key is entered in the Admin dashboard and encrypted with **AES‑256‑GCM** using `ENCRYPTION_KEY`. Only the ciphertext and the last 4 characters are stored. The key is decrypted in memory only inside server routes (`src/lib/claude.ts`). It is never returned to the browser and never logged (error text is passed through `redactSecrets`).
* Users get generic error messages for extraction failures. Nothing about the provider or the key reaches them.
* Routes are protected in two layers: `src/middleware.ts` (authentication, admin paths, forced password change), plus `requireUser()` / `requireAdmin()` in **every** API route. These re-read the user from the database, so deactivations take effect immediately.
* Uploads accept only PDF (magic bytes `%PDF-`, 25 MB maximum, sent in chunks) and XLSX (ZIP signature, 4 MB maximum).
* Conversions are rate-limited per user (default 10 per hour, configurable). Admins have a global maintenance switch and a monthly budget cap that blocks new conversions at 100%.
* No credentials are stored in the repository. Everything comes from environment variables.

---

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**. For local development, put them in `.env.local`, which is git-ignored. See `.env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string. For Supabase, use the **pooler** URL on port 6543 (transaction mode), e.g. `postgres://USER.PROJECTREF:PASSWORD@aws-1-REGION.pooler.supabase.com:6543/postgres`. |
| `NEXTAUTH_SECRET` | ✅ | Random secret used to sign session JWTs: `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | ✅ | Public URL of the app, e.g. `https://panel-bom-pricer.vercel.app`. |
| `ENCRYPTION_KEY` | ✅ | 32 random bytes, base64-encoded (`openssl rand -base64 32`) or 64 hex characters. Encrypts the Claude API key. **If you change it, re-enter the API key afterwards.** |
| `ADMIN_EMAIL` | ✅ | Email of the first admin account. |
| `ADMIN_PASSWORD` | ✅ | Temporary password for the first admin. It must be changed at first login. |
| `CRON_SECRET` | recommended | Vercel Cron sends `Authorization: Bearer $CRON_SECRET` to `/api/cron/health`. Without it, the scheduled health check is rejected. |

The Claude API key is **not** an environment variable. An admin enters it in the dashboard, and it is stored encrypted.

---

## Setup

### 1. Database

Any Postgres database works (Supabase, Neon / Vercel Postgres, RDS). The app uses its own schema, `bom`. On Supabase, create a dedicated login role for the app in the SQL editor:

```sql
CREATE ROLE bom_app LOGIN PASSWORD '<strong password>';
CREATE SCHEMA IF NOT EXISTS bom;
GRANT USAGE, CREATE ON SCHEMA bom TO bom_app;
GRANT CREATE ON DATABASE postgres TO bom_app;
ALTER ROLE bom_app SET search_path = bom;
```

Then use `postgres://bom_app.<project-ref>:<password>@<pooler-host>:6543/postgres` as `DATABASE_URL`.

Migrations in `drizzle/` are applied automatically by `npm run build` (`scripts/migrate.mjs`), so every Vercel deploy migrates the database. To apply them by hand, run `npm run db:migrate`.

### 2. Deploy to Vercel

1. Push this repository to GitHub as a private repository.
2. In Vercel, import the repository with the Next.js framework preset.
3. Add the environment variables listed above.
4. Deploy. The build applies the migrations, then runs `next build`.
5. `vercel.json` schedules the health check every 5 minutes (`*/5 * * * *`). On the Vercel Hobby plan, cron jobs may run at most once a day. If the deploy is rejected because of the schedule, change it to a daily one (e.g. `0 3 * * *`). The status card also uses the results of real calls and of the **Test connection** button.

### 3. Create the first admin

1. Sign in at `/login` with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. On the first sign-in, if no admin exists yet, the account is created automatically with the ADMIN role.
2. You are redirected to **Change password**. The new password must be at least 10 characters and different from `ADMIN_PASSWORD`.
3. Once an admin exists, the environment password can no longer create accounts. You can remove `ADMIN_PASSWORD` from Vercel if you like.

### 4. Configure the app (Admin dashboard)

1. **API connection**: paste the Claude API key, choose the model (default `claude-opus-5-5`) and click **Test connection**. A successful test shows the latency and the model name.
2. **Price files**: upload the consolidated price list (`samples/sample-price-file.xlsx` is an example). The first upload becomes active automatically. Later versions must be activated explicitly, and older versions are kept. Click **Duplicates & conflicts** to clean up rows that share a manufacturer P/N.
3. **Template & rules**: upload the output template (`samples/sample-template.xlsx`), set the default margin (0.125), set the budget cap and the rate limit, and add matching rules (device type → rating → optional qualifier → manufacturer P/N). `samples/sample-rules.json` lists the rules used with the sample price file.
4. **Users**: invite users. Each invite generates a one-time temporary password that the user changes at first login.

---

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run db:migrate
npm run dev                  # http://localhost:3000
```

## Tests & sample data

```bash
npm run seed:samples   # regenerates samples/ (drawing PDF, price file, template, rules)
npm test               # unit tests + end-to-end export test
```

`tests/e2e-export.test.ts` runs the full pipeline on `samples/sample-drawing.pdf`. The Claude responses for each sheet are replayed from `tests/fixtures/sample-extraction.json`, so the test is deterministic and makes no API calls. It checks the following:

* the RESERVED sheet is skipped and pages render to PNG;
* the device counts, the anomalies (duplicate tag H2, Q3 protection below motor FLC, X1 terminal clash) and the price-file conflict and duplicate are detected;
* the conflict is preselected to the row with a Terex P/N, and the unmatched thermostat stays unpriced;
* the workbook is grouped by MAKE in the correct order (`FINDER, PHOENIX CONTACT, SCHNEIDER, SIEMENS, LABOUR, REPUTED`), and every K/M/N, SUBTOTAL, GRAND TOTAL and summary formula **evaluates** to the hand-computed values (grand total 80,572.50 = sum of the subtotals, percentages sum to 100%);
* the header style, number formats, yellow unpriced cells and cell comments are correct.

## Project layout

```
src/lib/bom/        pure domain logic: aggregate, matching, grouping, excel, validation, pricefile
src/lib/claude.ts   Claude client (server-only), retry/backoff, error classification, call logging, cost
src/lib/extraction.ts  extraction prompt + strict JSON schema
src/lib/pdf.ts      page text, rendering (pdf.js + @napi-rs/canvas), single-page PDF fallback
src/lib/jobs.ts     job pipeline steps, matching run, re-pricing with changes report
src/app/api/…       route handlers (each one enforces auth/roles)
src/app/(app)/…     user dashboard, review screen, admin dashboard
drizzle/            SQL migrations
samples/, tests/    seed data and tests
```
