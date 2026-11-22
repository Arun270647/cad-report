import type { BomLine, ComponentGroup, PriceOption, PriceRow, RuleLike } from "./types";
import { normDeviceType, normMpn, normQualifier, normRating, normText, prettyDeviceType } from "./normalize";

/** Keywords that must appear in a price-row description for the description fallback. */
const DEVICE_KEYWORDS: Record<string, string[]> = {
  MCB: ["MCB", "MINIATURECIRCUITBREAKER"],
  MCCB: ["MCCB", "MOULDEDCASE", "MOLDEDCASE"],
  MPCB: ["MPCB", "MOTORPROTECTION", "MOTORCIRCUITBREAKER"],
  CONTACTOR: ["CONTACTOR"],
  OVERLOAD_RELAY: ["OVERLOAD", "OLR"],
  CONTROL_RELAY: ["RELAY"],
  TIMER_RELAY: ["TIMER"],
  PILOT_LAMP: ["LAMP", "INDICATOR", "PILOTLIGHT"],
  PUSHBUTTON: ["PUSHBUTTON", "PUSHBUTTON", "PB"],
  EMERGENCY_STOP: ["EMERGENCY", "ESTOP", "MUSHROOM"],
  SELECTOR_SWITCH: ["SELECTOR"],
  TERMINAL: ["TERMINAL"],
  FUSE: ["FUSE"],
  POWER_SUPPLY: ["POWERSUPPLY", "SMPS", "PSU"],
  TRANSFORMER: ["TRANSFORMER"],
};

export interface MatchContext {
  rules: RuleLike[];
  items: PriceRow[];
  margin: number;
}

function groupQualifiers(g: ComponentGroup): string[] {
  return [g.coilVoltage, g.colour, g.fn, g.contactConfig, g.relayType, g.poles].filter(Boolean).map((q) => normQualifier(q));
}

/** Rule lookup: exact device type + exact rating; qualifier-specific rules win over generic ones. */
export function findRuleMpns(g: ComponentGroup, rules: RuleLike[]): string[] {
  // Ratingless devices (e.g. pushbuttons) match rules whose rating is empty or "-".
  const candidates = rules.filter(
    (r) => normDeviceType(r.deviceType) === g.deviceType && normRating(r.rating).replace(/^-$/, "") === g.ratingNorm,
  );
  const quals = groupQualifiers(g);
  const specific = candidates.filter((r) => r.qualifier && quals.includes(normQualifier(r.qualifier)));
  const generic = candidates.filter((r) => !r.qualifier);
  const chosen = specific.length ? specific : generic;
  return [...new Set(chosen.map((r) => normMpn(r.mpn)).filter((x): x is string => !!x))];
}

function descriptionFallback(g: ComponentGroup, items: PriceRow[]): PriceRow[] {
  const kws = DEVICE_KEYWORDS[g.deviceType];
  if (!kws || !g.ratingNorm || g.ratingNorm.length < 2) return [];
  const rating = g.ratingNorm;
  const ratingRe = new RegExp(`(^|[^0-9.])${rating.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^0-9.])`);
  const quals = [g.colour, g.coilVoltage].filter(Boolean).map((q) => normText(q));
  return items.filter((it) => {
    const d = normText(it.description);
    if (!kws.some((k) => d.includes(k))) return false;
    if (!ratingRe.test(d)) return false; // exact rating only — never substitute
    return quals.every((q) => d.includes(q));
  });
}

function toOption(r: PriceRow): PriceOption {
  return {
    terexPn: r.terexPn,
    mpn: r.mpn,
    make: r.make,
    description: r.description,
    uom: r.uom,
    listPrice: r.listPrice,
    disc: r.disc,
    rowNumber: r.rowNumber,
  };
}

/** Distinct price options, rows with a Terex P/N first. */
export function distinctOptions(rows: PriceRow[]): PriceOption[] {
  const sorted = [...rows].sort((a, b) => Number(!!b.terexPn) - Number(!!a.terexPn) || a.rowNumber - b.rowNumber);
  const seen = new Map<string, PriceOption>();
  for (const r of sorted) {
    const k = [r.mpnNorm ?? normMpn(r.mpn), r.listPrice ?? "", r.disc ?? ""].join("|");
    if (!seen.has(k)) seen.set(k, toOption(r));
  }
  return [...seen.values()];
}

export function matchGroup(g: ComponentGroup, ctx: MatchContext, position: number): BomLine {
  let mpns = findRuleMpns(g, ctx.rules);
  let via = "rule";
  if (!mpns.length && g.mpn) {
    const n = normMpn(g.mpn);
    if (n) mpns = [n];
    via = "drawing P/N";
  }
  let rows: PriceRow[] = mpns.length ? ctx.items.filter((it) => it.mpnNorm && mpns.includes(it.mpnNorm)) : [];
  if (!rows.length && !mpns.length) {
    rows = descriptionFallback(g, ctx.items);
    via = "description + exact rating";
  }

  const base: BomLine = {
    position,
    terexPn: null,
    whereUsed: g.tags.join(", ").slice(0, 500) || null,
    drgSheetNo: g.sheets.join(", ").slice(0, 200) || null,
    description: g.descriptionHint,
    mpn: g.mpn ?? (mpns.length === 1 ? mpns[0] : null),
    make: g.make ? g.make.toUpperCase() : null,
    uom: "NOS",
    qty: g.qty,
    listPrice: null,
    disc: null,
    margin: ctx.margin,
    status: "matched",
    flags: [],
    alternatives: [],
    notes: null,
    sourceKey: g.key,
    sourceCount: g.qty,
  };
  const notes: string[] = [...g.notes];
  if (g.anomaly) base.flags.push("anomaly");

  if (!rows.length) {
    base.flags.push("not_found");
    notes.push(
      mpns.length
        ? `P/N ${mpns.join(" / ")} (${via}) not in active price list`
        : `No price row for ${prettyDeviceType(g.deviceType)} ${g.rating || "(no rating)"} — exact rating required`,
    );
  } else {
    const options = distinctOptions(rows);
    const chosen = options[0];
    base.terexPn = chosen.terexPn;
    base.mpn = chosen.mpn;
    base.make = chosen.make ? chosen.make.toUpperCase() : base.make;
    base.description = chosen.description ?? base.description;
    base.uom = chosen.uom ?? base.uom;
    base.listPrice = chosen.listPrice;
    base.disc = chosen.disc;
    if (options.length > 1) {
      base.flags.push("conflict");
      base.alternatives = options;
      notes.push(`${options.length} conflicting price rows — preselected the row with a Terex P/N; please confirm`);
    }
    if (chosen.listPrice == null) notes.push("Price row has no list price");
  }
  base.status = base.flags.includes("conflict")
    ? "conflict"
    : base.flags.includes("not_found")
      ? "not_found"
      : base.flags.includes("anomaly")
        ? "anomaly"
        : "matched";
  base.notes = notes.length ? notes.join("\n") : null;
  return base;
}

export function matchAll(groups: ComponentGroup[], ctx: MatchContext): BomLine[] {
  return groups.map((g, i) => matchGroup(g, ctx, i + 1));
}

/** Look up the best current price for an existing line by its manufacturer P/N (used for re-pricing). */
export function repriceLine(line: BomLine, items: PriceRow[]): { option: PriceOption | null; options: PriceOption[] } {
  const n = normMpn(line.mpn);
  if (!n) return { option: null, options: [] };
  const options = distinctOptions(items.filter((it) => it.mpnNorm === n));
  if (!options.length) return { option: null, options };
  const sameTerex = options.find((o) => line.terexPn && o.terexPn === line.terexPn);
  return { option: sameTerex ?? options[0], options };
}
