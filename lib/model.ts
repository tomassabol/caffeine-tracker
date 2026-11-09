// Pharmacokinetic model + settings shared by the engine and the React UI.

export type Drink = "coffee" | "matcha";
export const DRINKS: Drink[] = ["coffee", "matcha"];

export const DRINK_INFO: Record<Drink, { label: string; color: [number, number, number]; handle: [number, number, number] }> = {
  coffee: { label: "Coffee", color: [255, 255, 255], handle: [217, 217, 217] },
  matcha: { label: "Matcha", color: [134, 212, 104], handle: [134, 212, 104] },
};

export type Settings = {
  coffeeDose: number;
  coffeePeak: number;
  matchaDose: number;
  matchaPeak: number;
  halfLife: number;
  bed: number;
  limit: number;
  start: number;
};

// Defaults, with sources (see README):
// - coffeeDose 95 mg: USDA average for an 8 oz (240 ml) cup of brewed coffee; real cups run ~70-140 mg.
// - matchaDose 65 mg: a 2 g serving at ~32 mg/g (matcha measures 18.9-44.4 mg/g, Kolackova et al. 2020).
// - peaks 45 min: coffee peaked at 42 +/- 5 min in Liguori et al. 1997. No human study shows matcha's
//   caffeine absorbing more slowly, so matcha gets the same default; both stay adjustable.
// - halfLife 5 h: mean for healthy adults (range ~1.5-9.5 h; shorter in smokers, longer on oral
//   contraceptives or in pregnancy).
// - limit 50 mg: a conservative rule of thumb, not a clinical threshold. EFSA (2015) says 100 mg close
//   to bedtime may disturb sleep in some adults.
export const DEFAULT_SETTINGS: Settings = {
  coffeeDose: 95,
  coffeePeak: 45,
  matchaDose: 65,
  matchaPeak: 45,
  halfLife: 5,
  bed: 23,
  limit: 50,
  start: 6,
};

export type Field = {
  k: keyof Settings;
  label: string;
  sub: string;
  unit: string;
  min?: number;
  max?: number;
  step: number;
  time?: boolean;
};

export const FIELD_GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Coffee",
    fields: [
      { k: "coffeeDose", label: "Cup size", sub: "caffeine per cup", unit: "mg", min: 10, max: 400, step: 5 },
      { k: "coffeePeak", label: "Time to peak", sub: "minutes from cup to peak", unit: "min", min: 15, max: 180, step: 5 },
    ],
  },
  {
    title: "Matcha",
    fields: [
      { k: "matchaDose", label: "Bowl size", sub: "caffeine per serving", unit: "mg", min: 10, max: 400, step: 5 },
      { k: "matchaPeak", label: "Time to peak", sub: "minutes from bowl to peak", unit: "min", min: 15, max: 180, step: 5 },
    ],
  },
  {
    title: "You",
    fields: [
      { k: "halfLife", label: "Half-life", sub: "hours to halve the level", unit: "h", min: 2, max: 12, step: 0.5 },
      { k: "bed", label: "Bed time", sub: "level is checked here", unit: "", step: 0.25, time: true },
      { k: "limit", label: "Sleep limit", sub: "mg still in you at bed", unit: "mg", min: 10, max: 300, step: 5 },
      { k: "start", label: "Day starts", sub: "left edge of the chart", unit: "", min: 0, max: 12, step: 1, time: true },
    ],
  },
];
export const FIELDS: Field[] = FIELD_GROUPS.flatMap((g) => g.fields);

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export const fmtT = (t: number) => {
  let m = Math.round(t * 60);
  const h = Math.floor(m / 60) % 24;
  m = m % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
};

// Absorption rate from time-to-peak (Bateman function): solve ln(ka/ke)/(ka-ke) = tmax.
export function solveKa(tmaxH: number, ke: number) {
  let lo = ke * 1.0001,
    hi = 400;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const t = Math.log(mid / ke) / (mid - ke);
    if (t > tmaxH) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// One-compartment model with first-order absorption and elimination (Bateman function):
// mg of caffeine in the body `dt` hours after taking `dose` mg. Bioavailability is ~100%.
export function amount(dt: number, dose: number, ka: number, ke: number) {
  if (dt <= 0) return 0;
  return ((dose * ka) / (ka - ke)) * (Math.exp(-ke * dt) - Math.exp(-ka * dt));
}

export const doseOf = (s: Settings, d: Drink) => (d === "coffee" ? s.coffeeDose : s.matchaDose);
export const peakKey = (d: Drink): keyof Settings => (d === "coffee" ? "coffeePeak" : "matchaPeak");

// Clamp settings into a consistent state (time-to-peak must stay reachable for the half-life, bed after start).
export function normalize(s: Settings): Settings {
  const out = { ...s };
  for (const f of FIELDS) if (!f.time && f.min != null && f.max != null) out[f.k] = clamp(out[f.k], f.min, f.max);
  out.start = clamp(Math.round(out.start), 0, 12);
  const ke = Math.LN2 / out.halfLife;
  const maxPeak = Math.min(180, Math.floor(((0.95 / ke) * 60) / 5) * 5);
  out.coffeePeak = clamp(out.coffeePeak, 15, maxPeak);
  out.matchaPeak = clamp(out.matchaPeak, 15, maxPeak);
  out.bed = clamp(out.bed, out.start + 10, out.start + 23.75);
  return out;
}

export function fieldRange(f: Field, s: Settings): [number, number] {
  if (f.k === "bed") return [s.start + 10, s.start + 23.75];
  return [f.min ?? 0, f.max ?? 24];
}
