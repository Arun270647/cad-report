import type { Anomaly, ComponentGroup, DeviceCounts, ExtractedComponent, PageRecord } from "./types";
import { clean, normDeviceType, normQualifier, normRating, parseAmps, prettyDeviceType } from "./normalize";

interface Occurrence {
  comp: ExtractedComponent;
  page: number;
  sheet: string;
}

const PROTECTION_TYPES = new Set(["MPCB", "OVERLOAD_RELAY", "MCCB", "MCB"]);

function sheetOf(p: PageRecord): string {
  return clean(p.result?.sheet_number) ?? String(p.page);
}

function groupKey(c: ExtractedComponent): string {
  return [
    normDeviceType(c.device_type),
    normRating(c.rating),
    normQualifier(c.coil_voltage),
    normQualifier(c.poles),
    normQualifier(c.contact_config),
    normQualifier(c.colour),
    normQualifier(c.function),
    normQualifier(c.relay_type),
    normQualifier(c.manufacturer_pn),
  ].join("|");
}

function describe(c: ExtractedComponent): string {
  const parts = [prettyDeviceType(normDeviceType(c.device_type))];
  if (c.rating) parts.push(c.rating);
  if (c.poles) parts.push(c.poles);
  if (c.contact_config) parts.push(c.contact_config);
  if (c.relay_type) parts.push(c.relay_type);
  if (c.coil_voltage) parts.push(`coil ${c.coil_voltage}`);
  if (c.colour) parts.push(c.colour);
  if (c.function) parts.push(c.function);
  return parts.join(" ");
}

export interface AggregateResult {
  groups: ComponentGroup[];
  counts: DeviceCounts;
  anomalies: Anomaly[];
}

/**
 * Turn per-sheet extraction results into deduplicated, counted component groups.
 * Deterministic: tagged devices are counted once per unique tag (cross-sheet repeats with identical
 * attributes are merged); a tag reused with different attributes is a duplicate-tag anomaly.
 */
export function aggregate(pages: PageRecord[]): AggregateResult {
  const anomalies: Anomaly[] = [];
  const occurrences: Occurrence[] = [];
  for (const p of pages) {
    if (p.status !== "done" || !p.result || p.result.sheet_status !== "content") continue;
    for (const comp of p.result.components) occurrences.push({ comp, page: p.page, sheet: sheetOf(p) });
  }

  // --- tag dedupe & duplicate-tag anomalies
  const byTag = new Map<string, Occurrence[]>();
  const units: { occ: Occurrence; sheets: string[]; qty: number }[] = [];
  for (const o of occurrences) {
    const tag = clean(o.comp.tag)?.toUpperCase();
    if (normDeviceType(o.comp.device_type) === "TERMINAL") continue; // handled via terminal blocks
    if (!tag) {
      units.push({ occ: o, sheets: [o.sheet], qty: Math.max(1, Math.round(o.comp.quantity || 1)) });
      continue;
    }
    const list = byTag.get(tag) ?? [];
    list.push(o);
    byTag.set(tag, list);
  }
  const anomalousTags = new Set<string>();
  for (const [tag, list] of byTag) {
    const sigs = new Map<string, Occurrence[]>();
    for (const o of list) {
      const s = groupKey(o.comp);
      sigs.set(s, [...(sigs.get(s) ?? []), o]);
    }
    if (sigs.size > 1) {
      anomalousTags.add(tag);
      anomalies.push({
        type: "duplicate_tag",
        message: `Tag ${tag} is used for different devices: ${[...sigs.values()].map((l) => describe(l[0].comp)).join(" / ")}`,
        tags: [tag],
        sheets: [...new Set(list.map((o) => o.sheet))],
      });
    }
    for (const l of sigs.values()) {
      const sheets = [...new Set(l.flatMap((o) => [o.sheet, ...(o.comp.sheets ?? [])]))];
      units.push({ occ: l[0], sheets, qty: Math.max(1, Math.round(l[0].comp.quantity || 1)) });
    }
  }

  // --- protection settings below motor FLC
  const flcTags = new Set<string>();
  for (const u of units) {
    const c = u.occ.comp;
    const dt = normDeviceType(c.device_type);
    if (!PROTECTION_TYPES.has(dt) || c.motor_flc_a == null) continue;
    const setting = parseAmps(c.setting) ?? parseAmps(c.rating);
    if (setting != null && setting < c.motor_flc_a) {
      const tag = clean(c.tag)?.toUpperCase() ?? "(untagged)";
      flcTags.add(tag);
      anomalies.push({
        type: "protection_below_flc",
        message: `${tag}: protection ${c.setting ?? c.rating} (${setting} A) is below motor FLC ${c.motor_flc_a} A`,
        tags: [tag],
        sheets: u.sheets,
      });
    }
  }

  // --- group into BOM lines
  const groups = new Map<string, ComponentGroup>();
  for (const u of units) {
    const c = u.occ.comp;
    const key = groupKey(c);
    const tag = clean(c.tag)?.toUpperCase();
    const g = groups.get(key) ?? {
      key,
      deviceType: normDeviceType(c.device_type),
      rating: clean(c.rating) ?? "",
      ratingNorm: normRating(c.rating),
      coilVoltage: clean(c.coil_voltage),
      poles: clean(c.poles),
      contactConfig: clean(c.contact_config),
      colour: clean(c.colour),
      fn: clean(c.function),
      relayType: clean(c.relay_type),
      make: clean(c.make),
      mpn: clean(c.manufacturer_pn),
      qty: 0,
      tags: [],
      sheets: [],
      descriptionHint: describe(c),
      anomaly: false,
      notes: [],
    };
    g.qty += u.qty;
    if (tag) g.tags.push(tag);
    for (const s of u.sheets) if (!g.sheets.includes(s)) g.sheets.push(s);
    if (tag && (anomalousTags.has(tag) || flcTags.has(tag))) {
      g.anomaly = true;
      g.notes.push(anomalies.find((a) => a.tags.includes(tag))?.message ?? `Anomaly on ${tag}`);
    }
    groups.set(key, g);
  }

  // --- terminal blocks: count terminals per block, detect numbering clashes
  const terminalsPerBlock: Record<string, number> = {};
  const blockTerminals = new Map<string, Map<string, string[]>>();
  for (const p of pages) {
    if (p.status !== "done" || !p.result || p.result.sheet_status !== "content") continue;
    for (const tb of p.result.terminal_blocks ?? []) {
      const blockTag = (clean(tb.tag) ?? "X?").toUpperCase();
      const n = tb.terminals?.length ? tb.terminals.length : Math.max(0, Math.round(tb.count || 0));
      terminalsPerBlock[blockTag] = (terminalsPerBlock[blockTag] ?? 0) + n;
      const seen = blockTerminals.get(blockTag) ?? new Map<string, string[]>();
      for (const t of tb.terminals ?? []) {
        const k = String(t).trim().toUpperCase();
        seen.set(k, [...(seen.get(k) ?? []), sheetOf(p)]);
      }
      blockTerminals.set(blockTag, seen);
      const key = ["TERMINAL", normRating(tb.rating), normQualifier(tb.terminal_type)].join("|");
      const g = groups.get(key) ?? {
        key,
        deviceType: "TERMINAL",
        rating: clean(tb.rating) ?? "",
        ratingNorm: normRating(tb.rating),
        coilVoltage: null,
        poles: null,
        contactConfig: null,
        colour: null,
        fn: clean(tb.terminal_type),
        relayType: null,
        make: null,
        mpn: null,
        qty: 0,
        tags: [],
        sheets: [],
        descriptionHint: `TERMINAL ${[tb.terminal_type, tb.rating].filter(Boolean).join(" ")}`.trim(),
        anomaly: false,
        notes: [],
      };
      g.qty += n;
      if (!g.tags.includes(blockTag)) g.tags.push(blockTag);
      if (!g.sheets.includes(sheetOf(p))) g.sheets.push(sheetOf(p));
      groups.set(key, g);
    }
  }
  for (const [blockTag, seen] of blockTerminals) {
    const clashes = [...seen.entries()].filter(([, sheets]) => sheets.length > 1);
    if (clashes.length) {
      anomalies.push({
        type: "terminal_clash",
        message: `Terminal block ${blockTag}: terminal number(s) ${clashes.map(([t]) => t).join(", ")} used more than once`,
        tags: [blockTag],
        sheets: [...new Set(clashes.flatMap(([, s]) => s))],
      });
      for (const g of groups.values()) {
        if (g.deviceType === "TERMINAL" && g.tags.includes(blockTag)) {
          g.anomaly = true;
          g.notes.push(`Terminal numbering clash in ${blockTag}`);
        }
      }
    }
  }

  // --- counts
  const counts: DeviceCounts = {
    totalDevices: 0,
    pilotLampsByColour: {},
    pushbuttonsByFunction: {},
    relaysByType: {},
    terminalsPerBlock,
    byDeviceType: {},
  };
  const inc = (rec: Record<string, number>, k: string, n: number) => (rec[k] = (rec[k] ?? 0) + n);
  for (const g of groups.values()) {
    counts.totalDevices += g.qty;
    inc(counts.byDeviceType, g.deviceType, g.qty);
    if (g.deviceType === "PILOT_LAMP") inc(counts.pilotLampsByColour, (g.colour ?? "UNSPECIFIED").toUpperCase(), g.qty);
    if (g.deviceType === "PUSHBUTTON" || g.deviceType === "EMERGENCY_STOP")
      inc(counts.pushbuttonsByFunction, (g.fn ?? (g.deviceType === "EMERGENCY_STOP" ? "EMERGENCY STOP" : "UNSPECIFIED")).toUpperCase(), g.qty);
    if (g.deviceType === "CONTROL_RELAY" || g.deviceType === "TIMER_RELAY") {
      const t = [g.contactConfig ?? g.relayType ?? "", g.coilVoltage ?? ""].filter(Boolean).join(" ").toUpperCase() || "UNSPECIFIED";
      inc(counts.relaysByType, t, g.qty);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => a.deviceType.localeCompare(b.deviceType) || a.ratingNorm.localeCompare(b.ratingNorm));
  return { groups: ordered, counts, anomalies };
}
