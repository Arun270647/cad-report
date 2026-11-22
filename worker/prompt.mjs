// Constants for the local worker. Kept in sync with the app:
//   SYSTEM_PROMPT    <- the extraction instructions (originally src/lib/server/extract.ts, commit 3b277ee)
//   PAGE_JSON_SCHEMA <- src/lib/bom/page-schema.ts (tests/worker.test.ts asserts they are deep-equal)
//   DEVICE_TYPES     <- src/lib/bom/types.ts
// These are the ONLY things passed to Claude Code on the command line. Never put task data in here.

export const DEVICE_TYPES = [
  "MCB", "MCCB", "ACB", "MPCB", "RCCB", "CONTACTOR", "OVERLOAD_RELAY", "CONTROL_RELAY", "TIMER_RELAY",
  "PILOT_LAMP", "PUSHBUTTON", "EMERGENCY_STOP", "SELECTOR_SWITCH", "ROTARY_ISOLATOR", "ISOLATOR", "FUSE",
  "FUSE_HOLDER", "TRANSFORMER", "POWER_SUPPLY", "VFD", "SOFT_STARTER", "PLC", "PLC_IO_MODULE", "HMI",
  "TERMINAL", "METER", "CURRENT_TRANSFORMER", "SPD", "PHASE_MONITOR", "FAN", "FILTER", "THERMOSTAT",
  "HOOTER", "SOCKET", "PANEL_LIGHT", "LIMIT_SWITCH", "SENSOR", "CABLE", "OTHER",
];

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

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
};

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

/** The fixed user-message text that accompanies the page image (page is a validated integer). */
export function userText(page) {
  return `This is page ${page} of the drawing set. Extract the components as JSON.`;
}
