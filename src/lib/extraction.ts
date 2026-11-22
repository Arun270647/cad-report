import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callClaude, ClaudeCallError } from "./claude";
import { modelInfo } from "./settings";
import { DEVICE_TYPES, type PageExtraction } from "./bom/types";

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
      tag: ns,
      device_type: z.string(),
      description: ns,
      rating: ns,
      setting: ns,
      coil_voltage: ns,
      poles: ns,
      contact_config: ns,
      colour: ns,
      function: ns,
      relay_type: ns,
      quantity: z.number().int(),
      sheets: z.array(z.string()),
      make: ns,
      manufacturer_pn: ns,
      motor_flc_a: z.number().nullable(),
      motor_kw: z.number().nullable(),
    }),
  ),
  terminal_blocks: z.array(
    z.object({ tag: z.string(), terminal_type: ns, rating: ns, terminals: z.array(z.string()), count: z.number().int() }),
  ),
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

export interface ExtractInput {
  page: number;
  png?: Buffer;
  pdf?: Buffer;
  userId: string;
  jobId: string;
}

export async function extractPage(input: ExtractInput) {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.png) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: input.png.toString("base64") } });
  } else if (input.pdf) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdf.toString("base64") } });
  } else throw new Error("No page content");
  content.push({ type: "text", text: `This is page ${input.page} of the drawing set. Extract the components as JSON.` });

  return callClaude<PageExtraction>({ kind: "extract", userId: input.userId, jobId: input.jobId }, async (client, model) => {
    const info = modelInfo(model);
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32000,
      ...(info.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: PAGE_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      const e = new ClaudeCallError("refusal", "Model declined to process this sheet");
      Object.assign(e, { usage: msg.usage });
      throw e;
    }
    if (msg.stop_reason === "max_tokens") {
      const e = new ClaudeCallError("invalid_output", "Output truncated (max_tokens)");
      Object.assign(e, { usage: msg.usage });
      throw e;
    }
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let parsed: PageExtraction;
    try {
      parsed = PageZod.parse(JSON.parse(text)) as PageExtraction;
    } catch {
      const e = new ClaudeCallError("invalid_output", "Extraction did not match the JSON schema");
      Object.assign(e, { usage: msg.usage });
      throw e;
    }
    return { value: parsed, usage: msg.usage, model: msg.model };
  });
}
