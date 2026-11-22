import { z } from "zod";
import { DEVICE_TYPES } from "./types";

/**
 * Shape of ONE drawing sheet as returned by the extraction step.
 * The JSON Schema (for the worker's `claude --json-schema`) and the zod validator
 * (server-side trust boundary) MUST stay in sync.
 */
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };

export const PAGE_JSON_SCHEMA = {
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
          "catalog_id",
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
          catalog_id: nullableInteger,
        },
      },
    },
    terminal_blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "terminal_type", "rating", "terminals", "count", "catalog_id"],
        properties: {
          tag: { type: "string" },
          terminal_type: nullableString,
          rating: nullableString,
          terminals: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
          catalog_id: nullableInteger,
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

const s = z.string().max(500).nullable();
/** Optional so results stored before the catalog existed still validate. */
const catalogId = z.number().int().min(1).max(1_000_000).nullable().optional();
export const PageZod = z.object({
  sheet_number: s,
  sheet_title: s,
  sheet_status: z.enum(["content", "blank", "reserved"]),
  components: z
    .array(
      z.object({
        tag: s, device_type: z.string().max(40), description: s, rating: s, setting: s, coil_voltage: s, poles: s,
        contact_config: s, colour: s, function: s, relay_type: s, quantity: z.number().int().min(0).max(10000),
        sheets: z.array(z.string().max(50)).max(100), make: s, manufacturer_pn: s,
        motor_flc_a: z.number().nullable(), motor_kw: z.number().nullable(),
        catalog_id: catalogId,
      }),
    )
    .max(2000),
  terminal_blocks: z
    .array(
      z.object({
        tag: z.string().max(100), terminal_type: s, rating: s, terminals: z.array(z.string().max(30)).max(2000),
        count: z.number().int().min(0).max(10000), catalog_id: catalogId,
      }),
    )
    .max(500),
  notes: z.array(z.string().max(2000)).max(100),
  catalog_version: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
