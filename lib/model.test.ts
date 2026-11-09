import { describe, expect, test } from "bun:test";
import { amount, DEFAULT_SETTINGS, normalize, solveKa } from "./model";

const ke = (h: number) => Math.LN2 / h;

// Brute-force time of the maximum of amount() on a fine grid.
function numericTmax(ka: number, k: number) {
  let best = 0,
    bt = 0;
  for (let t = 0; t <= 24; t += 1 / 600) {
    const v = amount(t, 100, ka, k);
    if (v > best) [best, bt] = [v, t];
  }
  return bt;
}

describe("solveKa", () => {
  for (const half of [2, 5, 9.5])
    for (const peakMin of [15, 30, 45, 90])
      test(`peak lands at ${peakMin} min with ${half} h half-life`, () => {
        const ka = solveKa(peakMin / 60, ke(half));
        expect(Math.abs(numericTmax(ka, ke(half)) * 60 - peakMin)).toBeLessThan(0.2);
      });
});

describe("amount (Bateman)", () => {
  const k = ke(5);
  const ka = solveKa(45 / 60, k);

  test("zero before the drink", () => {
    expect(amount(0, 95, ka, k)).toBe(0);
    expect(amount(-1, 95, ka, k)).toBe(0);
  });

  test("area under the curve equals dose / ke (all caffeine absorbed, then eliminated)", () => {
    let auc = 0;
    const h = 1 / 120;
    for (let t = h / 2; t < 120; t += h) auc += amount(t, 95, ka, k) * h;
    expect(auc).toBeCloseTo(95 / k, 0);
  });

  test("halves every half-life once absorption is finished", () => {
    const a = amount(10, 95, ka, k);
    expect(amount(15, 95, ka, k) / a).toBeCloseTo(0.5, 4);
  });

  test("peak is below the dose (some is already gone by the peak)", () => {
    const peak = amount(45 / 60, 95, ka, k);
    expect(peak).toBeLessThan(95);
    expect(peak).toBeGreaterThan(80);
  });

  test("doses add linearly", () => {
    const one = amount(4, 95, ka, k);
    expect(amount(4, 190, ka, k)).toBeCloseTo(2 * one, 9);
  });
});

describe("default day", () => {
  test("coffee 08:00 + 11:00, matcha 15:30 leaves ~50-60 mg at 23:00", () => {
    const s = normalize(DEFAULT_SETTINGS);
    const k = ke(s.halfLife);
    const kc = solveKa(s.coffeePeak / 60, k);
    const km = solveKa(s.matchaPeak / 60, k);
    const bed =
      amount(23 - 8, s.coffeeDose, kc, k) + amount(23 - 11, s.coffeeDose, kc, k) + amount(23 - 15.5, s.matchaDose, km, k);
    // Hand check once absorption is over: dose * ka/(ka-ke) * 2^(-hours/halfLife).
    // The ka/(ka-ke) factor is the delay from absorption; it is ~1.0-1.1, so the
    // naive "dose halves every 5 h from the moment you drink it" is close but low.
    const tail = (dose: number, ka: number, h: number) => ((dose * ka) / (ka - k)) * 2 ** (-h / s.halfLife);
    const hand = tail(s.coffeeDose, kc, 15) + tail(s.coffeeDose, kc, 12) + tail(s.matchaDose, km, 7.5);
    expect(bed).toBeCloseTo(hand, 3);
    expect(bed).toBeGreaterThan(45);
    expect(bed).toBeLessThan(65);
  });
});

describe("normalize", () => {
  test("time to peak is capped so it stays reachable for a short half-life", () => {
    const s = normalize({ ...DEFAULT_SETTINGS, halfLife: 2, coffeePeak: 180 });
    // tmax can never exceed 1/ke = 2.885 h for a 2 h half-life
    expect(s.coffeePeak / 60).toBeLessThan(1 / ke(2));
  });
});
