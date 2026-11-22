# Panel BOM Pricer

Drag in an electrical control-panel drawing PDF and get back a priced Bill of Materials (BOM) in Excel, grouped by MAKE.

* **No sign-in, no database, no admin screens.** It is a single page.
* **Claude reads the drawings.** It reads each sheet through the Claude API. The key is stored only as a Vercel environment variable and is used server-side; it is never sent to the browser or committed to the repo.
* **Plain code does the rest.** Matching, pricing and the Excel output run as deterministic code in your browser. The price list never leaves your machine.

## Using it

1. Open the site.
2. Drop your **price list (.xlsx)** into the right-hand box. You only do this once, because the browser remembers it. Drop a new one to replace it.
3. Drop the **drawing PDF** into the big box. Optionally change the margin (12.5% by default).
4. Click **Convert to Excel**. Each sheet shows its progress: RESERVED and blank sheets are skipped, and the others are read by Claude, two at a time.
5. Review the on-screen summary, device counts and checks, then click **Download …_BOM.xlsx**.

### The price list

The first sheet needs a header row with these columns: `TEREX P/N, WHERE USED, DRG SHEET NO, DESCRIPTION, MANUFACTURE P/N, MAKE, UOM, QTY, LIST PRICE, Disc, Unit price, Margin, Terex Unit price, Total Price, TAG NO`. Discounts can be written as `0.35`, `35` or `35%`.

**Matching rules are optional.** Add a sheet whose name contains `RULES`, with the columns `Device type | Rating | Qualifier | Manufacturer P/N`, for example:

| Device type | Rating | Qualifier | Manufacturer P/N |
|---|---|---|---|
| MPCB | 13-18A | | GV2ME20 |
| CONTACTOR | 18A | 24VDC | LC1D18BD |
| PILOT_LAMP | - | GREEN | XB7NV63 |

Without rules, the app matches on a part number printed on the drawing, or on the device keyword plus the **exact** rating (and colour/function for lamps and pushbuttons) appearing in the price-list DESCRIPTION. `samples/sample-price-file.xlsx` shows the format, including a RULES sheet.

### What the Excel contains

* Columns A–N in the template layout, with **live formulas**: `K = I-(I*J)`, `M = K+(K*L)`, `N = H*M`.
* **Grouped by MAKE:** makes in alphabetical order, with generic entries (REPUTED, LABOUR, NON-STOCK, unspecified) last. Each make has a header row, its items and a `SUBTOTAL` (`=SUM(...)`). The `GRAND TOTAL` is the sum of the subtotal cells. A summary table follows: Make | Line count | Subtotal | % of total.
* Calibri 10, thin borders, yellow header row, discounts and margins as %, prices with thousand separators.
* **Never a guessed price:** if there is no exact rating match, the price is left blank and the cell is filled yellow.
* **Price conflicts** (same part, different prices) use the row with a Terex P/N. The alternatives are listed in the cell comment.
* Drawing notes, anomalies and conflicts appear as cell comments on the DESCRIPTION cell.

The page also reports pilot lamps by colour, pushbuttons by function, relays by type, terminals per block, and drawing anomalies: duplicate tags, terminal-number clashes, and protection settings below the motor FLC.

## Setup (Vercel)

Set these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Claude API key from <https://console.anthropic.com> → API keys. Billed per use. |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-opus-5-5`. |
| `APP_PASSCODE` | optional | If set, the site asks for this passcode once per browser. Recommended, because without it anyone with the URL can spend your API credit. |

No other configuration is needed. The only server code is `src/app/api/extract/route.ts`, which takes one sheet image and returns the JSON. It retries with backoff on rate-limit, overload and timeout errors.

## Local development

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # git-ignored
npm run dev            # http://localhost:3000
npm test               # unit tests + end-to-end export test
npm run seed:samples   # regenerate samples/
```

## Tests and sample data

* `samples/sample-drawing.pdf`: a 4-sheet panel drawing (sheet 3 is RESERVED).
* `samples/sample-price-file.xlsx`: a price list containing one conflict, one duplicate and a RULES sheet.
* `tests/e2e-export.test.ts`: runs the whole pipeline on the samples, replaying Claude's per-sheet output from `tests/fixtures/sample-extraction.json` so it makes no API calls. It then re-opens the generated Excel and checks the following:
  * the make order, header rows and SUBTOTAL ranges;
  * that every formula evaluates to the hand-computed values (grand total 80,572.50 = sum of the subtotals, percentages add up to 100%);
  * the styling, the yellow unpriced cells and the comments.

## Project layout

```
src/app/page.tsx              the whole UI (drag & drop, progress, preview, download)
src/app/api/extract/route.ts  the only server endpoint (holds the API key)
src/lib/server/extract.ts     Claude call: prompt, strict JSON schema, retries
src/lib/client/               browser PDF rendering (pdf.js) + conversion driver
src/lib/bom/                  aggregation, matching, group-by-make, Excel, validation, price-file parsing
```
