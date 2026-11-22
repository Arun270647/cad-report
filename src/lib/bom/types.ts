export const DEVICE_TYPES = [
  "MCB", "MCCB", "ACB", "MPCB", "RCCB", "CONTACTOR", "OVERLOAD_RELAY", "CONTROL_RELAY", "TIMER_RELAY",
  "PILOT_LAMP", "PUSHBUTTON", "EMERGENCY_STOP", "SELECTOR_SWITCH", "ROTARY_ISOLATOR", "ISOLATOR", "FUSE",
  "FUSE_HOLDER", "TRANSFORMER", "POWER_SUPPLY", "VFD", "SOFT_STARTER", "PLC", "PLC_IO_MODULE", "HMI",
  "TERMINAL", "METER", "CURRENT_TRANSFORMER", "SPD", "PHASE_MONITOR", "FAN", "FILTER", "THERMOSTAT",
  "HOOTER", "SOCKET", "PANEL_LIGHT", "LIMIT_SWITCH", "SENSOR", "CABLE", "OTHER",
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface ExtractedComponent {
  tag: string | null;
  device_type: string;
  description: string | null;
  rating: string | null;
  setting: string | null;
  coil_voltage: string | null;
  poles: string | null;
  contact_config: string | null;
  colour: string | null;
  function: string | null;
  relay_type: string | null;
  quantity: number;
  sheets: string[];
  make: string | null;
  manufacturer_pn: string | null;
  motor_flc_a: number | null;
  motor_kw: number | null;
}

export interface TerminalBlock {
  tag: string;
  terminal_type: string | null;
  rating: string | null;
  terminals: string[];
  count: number;
}

export interface PageExtraction {
  sheet_number: string | null;
  sheet_title: string | null;
  sheet_status: "content" | "blank" | "reserved";
  components: ExtractedComponent[];
  terminal_blocks: TerminalBlock[];
  notes: string[];
}

export interface PageRecord {
  page: number;
  status: "pending" | "skipped" | "done" | "error";
  skipReason?: string;
  sheet?: string | null;
  mode?: "image" | "pdf";
  result?: PageExtraction;
  error?: string;
}

export interface Anomaly {
  type: "duplicate_tag" | "terminal_clash" | "protection_below_flc" | "unreadable_sheet";
  message: string;
  tags: string[];
  sheets: string[];
}

export interface ComponentGroup {
  key: string;
  deviceType: string;
  rating: string;
  ratingNorm: string;
  coilVoltage: string | null;
  poles: string | null;
  contactConfig: string | null;
  colour: string | null;
  fn: string | null;
  relayType: string | null;
  make: string | null;
  mpn: string | null;
  qty: number;
  tags: string[];
  sheets: string[];
  descriptionHint: string;
  anomaly: boolean;
  notes: string[];
}

export interface PriceRow {
  id?: number;
  rowNumber: number;
  terexPn: string | null;
  whereUsed: string | null;
  drgSheetNo: string | null;
  description: string | null;
  mpn: string | null;
  mpnNorm: string | null;
  make: string | null;
  uom: string | null;
  qty: number | null;
  listPrice: number | null;
  disc: number | null;
  unitPrice: number | null;
  margin: number | null;
  terexUnitPrice: number | null;
  totalPrice: number | null;
  tagNo: string | null;
}

export interface RuleLike {
  deviceType: string;
  rating: string;
  qualifier: string | null;
  mpn: string;
}

export type LineStatus = "matched" | "conflict" | "not_found" | "anomaly" | "manual";

export interface PriceOption {
  terexPn: string | null;
  mpn: string | null;
  make: string | null;
  description: string | null;
  uom: string | null;
  listPrice: number | null;
  disc: number | null;
  rowNumber: number;
}

export interface BomLine {
  id?: number;
  position: number;
  terexPn: string | null;
  whereUsed: string | null;
  drgSheetNo: string | null;
  description: string | null;
  mpn: string | null;
  make: string | null;
  uom: string | null;
  qty: number;
  listPrice: number | null;
  disc: number | null;
  margin: number;
  status: LineStatus;
  flags: string[];
  alternatives: PriceOption[];
  notes: string | null;
  sourceKey: string | null;
  sourceCount: number | null;
}

export interface DeviceCounts {
  totalDevices: number;
  pilotLampsByColour: Record<string, number>;
  pushbuttonsByFunction: Record<string, number>;
  relaysByType: Record<string, number>;
  terminalsPerBlock: Record<string, number>;
  byDeviceType: Record<string, number>;
}
