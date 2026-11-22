import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DEVICE_TYPES, type PageExtraction } from "../bom/types";

/** Models that support server-side refusal fallbacks (beta). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export type ErrorType = "auth" | "rate_limit" | "timeout" | "overloaded" | "refusal" | "invalid_output" | "not_configured" | "other";

export class ExtractError extends Error {
  constructor(public errorType: ErrorType, message: string, public retryable = false) {
    super(message);
  }
}

export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***");
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

/** Strict JSON schema for one drawing sheet (structured outputs). */
export const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sheet_number", "sheet_title", "sheet_status", "components", "terminal_blocks", "notes"],
  properties: {
    sheet_number: nullableString,
    sheet_title: nullableString,
    sheet_status: { type: "string", enum: ["content", "blank", "reserved"] },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "tag", "device_type", "description", "rating", "setting", "coil_voltage", "poles", "contact_config",
          "colour", "function", "relay_type", "quantity", "sheets", "make", "manufacturer_pn", "motor_flc_a", "motor_kw",
        ],
        properties: {
          tag: nullableString,
          device_type: { type: "string", enum: [...DEVICE_TYPES] },
          description: nullableString,
          rating: nullableString,
          setting: nullableString,
          coil_voltage: nullableString,
          poles: nullableString,
          contact_config: nullableString,
          colour: nullableString,
          function: nullableString,
          relay_type: nullableString,
          quantity: { type: "integer" },
          sheets: { type: "array", items: { type: "string" } },
          make: nullableString,
          manufacturer_pn: nullableString,
          motor_flc_a: nullableNumber,
          motor_kw: nullableNumber,
        },
      },
    },
    terminal_blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "terminal_type", "rating", "terminals", "count"],
        properties: {
          tag: { type: "string" },
          terminal_type: nullableString,
          rating: nullableString,
          terminals: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

const ns = z.string().nullable();
const PageZod = z.object({
  sheet_number: ns,
  sheet_title: ns,
  sheet_status: z.enum(["content", "blank", "reserved"]),
  components: z.array(
    z.object({
      tag: ns, device_type: z.string(), description: ns, rating: ns, setting: ns, coil_voltage: ns, poles: ns,
      contact_config: ns, colour: ns, function: ns, relay_type: ns, quantity: z.number().int(), sheets: z.array(z.string()),
      make: ns, manufacturer_pn: ns, motor_flc_a: z.number().nullable(), motor_kw: z.number().nullable(),
    }),
  ),
  terminal_blocks: z.array(z.object({ tag: z.string(), terminal_type: ns, rating: ns, terminals: z.array(z.string()), count: z.number().int() })),
  notes: z.array(z.string()),
});

export const SYSTEM_PROMPT = `You are an expert electrical estimator reading ONE sheet of an industrial control-panel drawing (IEC/ANSI schematics, power & control circuits, terminal layouts, panel GA, BOM tables).

Return strict JSON matching the schema. Rules:
- sheet_number: the sheet/page number printed in the title block (e.g. "3", "=E/5"). sheet_title from the title block.
- sheet_status: "reserved" if the sheet is marked RESERVED / intentionally left blank / spare; "blank" if it has no circuit content (only border/title block). In both cases return empty components and terminal_blocks.
- components: list every physical device whose MAIN symbol appears on THIS sheet, once per device tag. Do NOT list cross-reference contacts or coil references that point to a device drawn on another sheet (e.g. "K1 /5.3" contact references). If the sheet is a BOM/parts table, list each table row as a component.
- tag: device tag exactly as printed (e.g. "Q1", "-K12", "H3"); null if untagged. If several identical untagged devices are drawn, use one entry with quantity = count; tagged devices always have quantity 1 (expand ranges like "F1-F3" into separate entries).
- device_type: pick the closest enum value. Pilot/indicator lights = PILOT_LAMP; mushroom e-stop = EMERGENCY_STOP; motor protection circuit breaker = MPCB; thermal overload = OVERLOAD_RELAY; interposing/auxiliary relays = CONTROL_RELAY.
- rating: the device rating or setting range exactly as printed, normalised to forms like "13-18A", "6A", "32A", "2.5sqmm", "24VDC 5A", "100VA". For MPCB/overloads use the adjustable range (e.g. "13-18A"); put the actual dial setting in "setting" (e.g. "16A").
- coil_voltage for contactors/relays/timers (e.g. "24VDC", "230VAC"). poles e.g. "3P", "4P", "1P+N". contact_config e.g. "1NO+1NC", "2C/O", "4C/O".
- relay_type: for relays "2C/O" or "4C/O" plus AC/DC coil, e.g. "2C/O DC"; for timers "ON-DELAY"/"OFF-DELAY"/"STAR-DELTA".
- colour for lamps and pushbuttons (RED, GREEN, AMBER, YELLOW, BLUE, WHITE, BLACK). function for pushbuttons/selectors/lamps (e.g. "START", "STOP", "RESET", "TRIP", "ON", "RUN", "LAMP TEST", "AUTO/MANUAL").
- sheets: other sheet numbers where this same device is referenced (from cross-reference text), may be empty.
- make and manufacturer_pn only if printed on the drawing; never guess part numbers.
- motor_flc_a / motor_kw: only for the protective device (MPCB/overload/MCCB) feeding a motor whose FLC (A) or kW is printed on this sheet; else null.
- terminal_blocks: for terminal strips (e.g. "X1", "-XD1"), list the terminal numbers drawn on this sheet in "terminals" and set count = number of terminals; terminal_type e.g. "FEED-THROUGH", "EARTH", "FUSE", "DISCONNECT"; rating e.g. "2.5sqmm", "4sqmm". Do not also list terminals as components.
- notes: anything ambiguous or illegible that an estimator should check.
Never invent devices. If unreadable, return what you can and explain in notes.`;

function classify(err: unknown): ExtractError {
  const msg = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
  if (err instanceof ExtractError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ExtractError("timeout", msg, true);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ExtractError("auth", msg);
  if (err instanceof Anthropic.RateLimitError) return new ExtractError("rate_limit", msg, true);
  if (err instanceof Anthropic.APIConnectionError) return new ExtractError("timeout", msg, true);
  if (err instanceof Anthropic.APIError) {
    const body = (err.error ?? {}) as { error?: { type?: string } };
    if (err.status === 529 || body?.error?.type === "overloaded_error") return new ExtractError("overloaded", msg, true);
    if (err.status && err.status >= 500) return new ExtractError("other", msg, true);
  }
  return new ExtractError("other", msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one rendered sheet to Claude and return validated JSON.
 * Retries with exponential backoff on rate-limit / overload / timeout.
 */
export async function extractSheet(image: { data: string; mediaType: "image/png" | "image/jpeg" }, page: number) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ExtractError("not_configured", "ANTHROPIC_API_KEY is not set in the Vercel project");
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 200_000 });
  const deadline = Date.now() + 270_000;
  let last: ExtractError | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t0 = Date.now();
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        ...(FALLBACK_MODELS.has(MODEL) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: PAGE_SCHEMA as unknown as Record<string, unknown> } },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
              { type: "text", text: `This is page ${page} of the drawing set. Extract the components as JSON.` },
            ],
          },
        ],
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw new ExtractError("refusal", "The model declined to process this sheet");
      if (msg.stop_reason === "max_tokens") throw new ExtractError("invalid_output", "Output truncated", true);
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      let parsed: PageExtraction;
      try {
        parsed = PageZod.parse(JSON.parse(text)) as PageExtraction;
      } catch {
        throw new ExtractError("invalid_output", "Extraction did not match the JSON schema", true);
      }
      return {
        result: parsed,
        model: msg.model,
        latencyMs: Date.now() - t0,
        usage: { input: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), output: msg.usage.output_tokens ?? 0 },
      };
    } catch (e) {
      last = classify(e);
      console.warn(`[extract] page ${page} attempt ${attempt} failed: ${last.errorType}`);
      if (!last.retryable || attempt === 4) break;
      const backoff = Math.min(30_000, 2000 * 2 ** (attempt - 1)) + Math.random() * 500;
      if (Date.now() + backoff + 30_000 > deadline) break;
      await sleep(backoff);
    }
  }
  throw last ?? new ExtractError("other", "Extraction failed");
}
