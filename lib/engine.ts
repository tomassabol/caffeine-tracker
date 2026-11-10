// Canvas renderer + interaction for the caffeine curve. Framework-free; the React
// component mounts it and talks to it through the public methods and `subscribe`.
import {
  amount,
  clamp,
  DEFAULT_SETTINGS,
  DRINK_INFO,
  doseOf,
  fmtT,
  FIELDS,
  normalize,
  solveKa,
  type Drink,
  type Settings,
} from "./model";

type RGB = [number, number, number];
type Cup = { t: number; kind: Drink; sel: number; act: number };

export type Snapshot = {
  count: number;
  coffee: number;
  matcha: number;
  drink: Drink;
  selectedKind: Drink | null;
  settings: Settings;
  status: string;
};

const STORE_KEY = "caffeine-curve-v2";
const DEFAULT_CUPS: { t: number; kind: Drink }[] = [
  { t: 8, kind: "coffee" },
  { t: 11, kind: "coffee" },
  { t: 15.5, kind: "matcha" },
];
export const MAX_CUPS = 10;
/** Credit link drawn as HTML over the canvas; the engine only decides where it sits. */
export const CREDIT = { text: "made by @tomassabol", href: "https://github.com/tomassabol" };
const CREDIT_SIZE = 17;

const BG: RGB = [12, 12, 12];
const BLUE: RGB = [46, 130, 255];
const WHITE: RGB = [255, 255, 255];
const CELL = 8,
  FIT_ROWS = 47,
  FLOOR_MG = 160,
  MAXROWS = 56,
  HOURS = 24;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mix = (c1: RGB, c2: RGB, k: number): RGB => [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const noun = (kind: Drink, n: number) => (kind === "coffee" ? (n === 1 ? "COFFEE" : "COFFEES") : "MATCHA");

function topIntensity(age: number) {
  if (!isFinite(age)) return 0.25;
  let bump;
  if (age < 0.6) bump = 0.72 + 0.28 * (age / 0.6);
  else {
    const z = (age - 0.6) / 0.38;
    bump = Math.exp(-0.5 * z * z);
  }
  return 0.25 + 0.75 * bump;
}
function colorFresh(age: number) {
  if (age < 0.7) return 1;
  const z = (age - 0.7) / 0.7;
  return Math.exp(-0.5 * z * z);
}
const dotRadius = (I: number) => 1 + 2.3 * Math.pow(clamp((I - 0.13) / 0.6, 0, 1), 0.8);

// Separable box blur over the grid; the bottom edge counts as filled.
function blur(src: Float32Array, rad: number, COLS: number) {
  const tmp = new Float32Array(COLS * MAXROWS),
    out = new Float32Array(COLS * MAXROWS);
  const n = 2 * rad + 1;
  for (let r = 0; r < MAXROWS; r++)
    for (let c = 0; c < COLS; c++) {
      let s = 0;
      for (let d = -rad; d <= rad; d++) {
        const cc = c + d;
        if (cc >= 0 && cc < COLS) s += src[cc * MAXROWS + r];
      }
      tmp[c * MAXROWS + r] = s / n;
    }
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < MAXROWS; r++) {
      let s = 0;
      for (let d = -rad; d <= rad; d++) {
        const rr = r + d;
        if (rr < 0) s += tmp[c * MAXROWS];
        else if (rr < MAXROWS) s += tmp[c * MAXROWS + rr];
      }
      out[c * MAXROWS + r] = s / n;
    }
  return out;
}

type Layout = {
  LW: number;
  LH: number;
  L: number;
  R: number;
  W: number;
  COLS: number;
  compact: boolean;
  yAxis: number;
  yHandle: number;
  row0: number;
  lineTop: number;
  label1: number;
  label2: number;
  yAxisLabels: number;
  titleY: number;
  subY: number;
  footY: number;
  padX: number;
  u: number;
};

export class CurveEngine {
  private S: Settings = { ...DEFAULT_SETTINGS };
  private ka: Record<Drink, number> = { coffee: 3, matcha: 2 };
  private cups: Cup[] = DEFAULT_CUPS.map((c) => ({ ...c, sel: 0, act: 0 }));
  private drink: Drink = "coffee";
  private selected: Cup | null = null;
  private hovered: Cup | null = null;
  private drag: { cup: Cup; offset: number; wasSelected: boolean; moved: boolean; sx: number; sy: number } | null = null;
  private pending: { sx: number; sy: number; moved: boolean } | null = null;
  // bed line: hovered / being dragged, its animated highlight, and its label box from the last frame
  private bedHover = false;
  private bedDrag: { offset: number } | null = null;
  private bedAct = 0;
  private bedBox = { x0: 0, x1: 0 };
  private pointer: { x: number; y: number } | null = null;
  private maxMgAnim = 160;
  private peakAlpha = 0;
  private LY!: Layout;
  private dpr = 1;
  private cw = 600;
  private ch = 600;
  private last = 0;
  private raf = 0;
  private ctx!: CanvasRenderingContext2D;
  private canvas!: HTMLCanvasElement;
  private stage!: HTMLElement;
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private status = "";
  private cleanup: (() => void)[] = [];
  private reduced = false;

  // Safe to construct on the server: no DOM or storage access until mount().
  constructor(private font: string) {
    this.applySettings();
    this.snap = this.makeSnap();
  }

  mount(canvas: HTMLCanvasElement, stage: HTMLElement) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext("2d")!;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.load();
    this.applySettings();
    this.resize();
    this.bindEvents();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.emit();
    return () => {
      cancelAnimationFrame(this.raf);
      for (const f of this.cleanup) f();
      this.cleanup = [];
    };
  }

  // ---------- store for React ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private makeSnap(): Snapshot {
    const coffee = this.cups.filter((c) => c.kind === "coffee").length;
    return {
      count: this.cups.length,
      coffee,
      matcha: this.cups.length - coffee,
      drink: this.drink,
      selectedKind: this.selected?.kind ?? null,
      settings: { ...this.S },
      status: this.status,
    };
  }
  private emit() {
    this.snap = this.makeSnap();
    for (const l of this.listeners) l();
  }
  private announce(s: string) {
    this.status = s;
  }

  // ---------- model ----------
  private get ke() {
    return Math.LN2 / this.S.halfLife;
  }
  private applySettings() {
    this.S = normalize(this.S);
    const ke = this.ke;
    this.ka.coffee = solveKa(this.S.coffeePeak / 60, ke);
    this.ka.matcha = solveKa(this.S.matchaPeak / 60, ke);
    for (const c of this.cups) {
      while (c.t < this.S.start) c.t += 24;
      while (c.t >= this.S.start + 24) c.t -= 24;
    }
  }
  private contrib(dt: number, kind: Drink) {
    return amount(dt, doseOf(this.S, kind), this.ka[kind], this.ke);
  }
  private totalAt(t: number) {
    let s = 0;
    for (const c of this.cups) s += this.contrib(t - c.t, c.kind);
    return s;
  }
  private findPeak() {
    let best = 0,
      bt = this.S.start;
    for (let i = 0; i <= HOURS * 60; i += 2) {
      const t = this.S.start + i / 60;
      const v = this.totalAt(t);
      if (v > best) {
        best = v;
        bt = t;
      }
    }
    return { mg: best, t: bt };
  }
  private footerText() {
    const L = this.LY;
    if (!this.cups.length) return L.compact ? "TAP THE CHART OR + TO ADD A DRINK" : "CLICK THE CHART OR + TO ADD A DRINK";
    const S = this.S;
    const sorted = [...this.cups].sort((a, b) => a.t - b.t);
    const others = sorted.slice(0, -1);
    const night = (T: number | null, kind: Drink) => {
      let m = 0;
      for (let t = S.bed; t <= S.bed + 7; t += 1 / 12) {
        let v = T == null ? 0 : this.contrib(t - T, kind);
        for (const c of others) v += this.contrib(t - c.t, c.kind);
        if (v > m) m = v;
      }
      return m;
    };
    if (night(null, "coffee") > S.limit) return "OVER THE LINE EVEN WITHOUT THE LAST DRINK";
    // latest time the last drink of the day could be each kind and still stay under the line
    const lastBy = (kind: Drink) => {
      for (let T = S.bed; T >= S.start; T -= 0.25) if (night(T, kind) <= S.limit) return fmtT(T);
      return null;
    };
    const c = lastBy("coffee"),
      m = lastBy("matcha");
    if (!c && !m) return "NO ROOM FOR ANOTHER DRINK TODAY";
    const part = (k: string, t: string | null) => (t ? `${k} BY ${t}` : `NO ${k}`);
    return `LAST ${part("COFFEE", c)} · ${part("MATCHA", m)}`;
  }

  // ---------- persistence ----------
  private save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ cups: this.cups.map((c) => ({ t: +c.t.toFixed(4), kind: c.kind })), settings: this.S, drink: this.drink }),
      );
    } catch {
      /* storage unavailable: run without it */
    }
  }
  private load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d?.settings)
        for (const f of FIELDS) {
          const v = +d.settings[f.k];
          if (Number.isFinite(v)) this.S[f.k] = v;
        }
      if (d?.drink === "coffee" || d?.drink === "matcha") this.drink = d.drink;
      if (
        Array.isArray(d?.cups) &&
        d.cups.length <= MAX_CUPS &&
        d.cups.every((c: { t: unknown; kind: unknown }) => Number.isFinite(c?.t) && (c.kind === "coffee" || c.kind === "matcha"))
      ) {
        this.cups = d.cups.map((c: { t: number; kind: Drink }) => ({ t: c.t, kind: c.kind, sel: 0, act: 0 }));
      }
    } catch {
      /* ignore bad or blocked storage */
    }
  }

  // ---------- public actions ----------
  setDrink(d: Drink) {
    this.drink = d;
    // switching while a cup is selected converts that cup
    if (this.selected && this.selected.kind !== d) {
      this.selected.kind = d;
      this.announce(`Cup at ${fmtT(this.selected.t)} is now ${d}.`);
    }
    this.save();
    this.emit();
  }
  setSetting(k: keyof Settings, v: number) {
    this.S = { ...this.S, [k]: v };
    this.applySettings();
    this.save();
    this.emit();
  }
  resetSettings() {
    this.S = { ...DEFAULT_SETTINGS };
    this.applySettings();
    this.save();
    this.announce("Parameters reset to defaults.");
    this.emit();
  }
  resetCups() {
    this.cups = DEFAULT_CUPS.map((c) => ({ ...c, sel: 0, act: 0 }));
    this.selected = this.hovered = null;
    this.drag = this.pending = null;
    this.applySettings();
    this.save();
    this.announce("Drinks reset: coffee 08:00 and 11:00, matcha 15:30.");
    this.emit();
  }
  addCup(kind: Drink = this.drink) {
    if (this.cups.length >= MAX_CUPS) return;
    this.drink = kind; // chart taps add whichever drink was used last
    const c: Cup = { t: this.nextCupTime(), kind, sel: 0, act: 0 };
    this.cups.push(c);
    this.selected = c;
    this.hovered = null;
    this.save();
    this.announce(`${DRINK_INFO[c.kind].label} added at ${fmtT(c.t)}.`);
    this.emit();
  }
  // removes the selected drink if it is this kind, otherwise the latest drink of this kind
  removeCup(kind: Drink) {
    const mine = this.cups.filter((c) => c.kind === kind);
    if (!mine.length) return;
    this.drink = kind;
    const gone = this.selected?.kind === kind ? this.selected : mine.reduce((a, b) => (b.t > a.t ? b : a));
    this.cups = this.cups.filter((c) => c !== gone);
    this.selected = this.hovered = null;
    this.save();
    this.announce(`${DRINK_INFO[gone.kind].label} at ${fmtT(gone.t)} removed.`);
    this.emit();
  }
  // 3 h after the last drink; when that passes bed time, the middle of the widest gap before bed
  private nextCupTime() {
    const S = this.S;
    const day = this.cups
      .map((c) => c.t)
      .filter((t) => t <= S.bed)
      .sort((a, b) => a - b);
    if (!day.length) return clamp(8, S.start, S.bed);
    const last = day[day.length - 1];
    if (last + 3 < S.bed) return last + 3;
    let gap = 0,
      mid = last,
      prev = S.start;
    for (const t of [...day, S.bed]) {
      if (t - prev > gap) {
        gap = t - prev;
        mid = (prev + t) / 2;
      }
      prev = t;
    }
    return Math.round(mid * 4) / 4;
  }

  // ---------- layout ----------
  resize = () => {
    const parent = this.stage.parentElement!;
    const bw = Math.max(200, parent.clientWidth - 32),
      bh = Math.max(200, parent.clientHeight);
    if (bw < bh) {
      this.cw = bw;
      this.ch = bh;
    } else this.cw = this.ch = Math.min(bw, bh);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const { cw, ch } = this;
    const LW = cw >= 700 ? 1080 : clamp(Math.round(cw * 1.64), 640, 1080);
    const LH = Math.round((LW * ch) / cw);
    const compact = LW < 1080;
    const L = compact ? 28.5 : 130.5;
    const R = compact ? LW - 50.5 : LW - 130.5;
    const W = R - L;
    const COLS = Math.floor((W - 4) / CELL) + 1;
    let yAxis;
    if (!compact && LH === LW) yAxis = 804.5;
    else {
      const block = 454 + 40 + 75 + 20;
      const top = 90 + Math.max(0, LH - 150 - block) / 2;
      // compact layouts may need a second footer line for the credit
      yAxis = Math.round(clamp(top + 40 + 454, 560, LH - (compact ? 150 : 120))) + 0.5;
    }
    this.LY = {
      LW,
      LH,
      L,
      R,
      W,
      COLS,
      compact,
      yAxis,
      yHandle: yAxis + 28,
      row0: yAxis - 5,
      lineTop: yAxis - 454.5,
      label1: yAxis - 481.5,
      label2: yAxis - 457.5,
      yAxisLabels: yAxis + 75.5,
      titleY: 48,
      subY: 77,
      footY: LH - 29,
      padX: 33,
      u: cw / LW,
    };
    this.stage.style.width = cw + "px";
    this.stage.style.height = ch + "px";
    this.stage.style.setProperty("--u", String(this.LY.u));
    this.stage.style.setProperty("--credit-y", this.LY.footY * this.LY.u + "px");
    this.canvas.style.width = cw + "px";
    this.canvas.style.height = ch + "px";
    this.canvas.width = Math.round(cw * this.dpr);
    this.canvas.height = Math.round(ch * this.dpr);
  };

  private t2x = (t: number) => this.LY.L + ((t - this.S.start) / HOURS) * this.LY.W;
  private x2t = (x: number) => this.S.start + ((x - this.LY.L) / this.LY.W) * HOURS;
  private colX = (k: number) => this.LY.L + 4 + CELL * k;
  private rowY = (r: number) => this.LY.row0 - CELL * r;

  // ---------- drawing ----------
  private text(str: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", weight = 400) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${this.font}`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  private measure(str: string, size: number, weight = 400) {
    this.ctx.font = `${weight} ${size}px ${this.font}`;
    return this.ctx.measureText(str).width;
  }
  private dot(x: number, y: number, r: number, style: string) {
    const ctx = this.ctx;
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.draw(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(dt: number) {
    const { ctx, S, cups, LY } = this;
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.16);
    const { LW, LH, L, R, W, COLS, yAxis, yHandle, lineTop, label1, label2 } = LY;

    for (const c of cups) {
      c.sel += ((c === this.selected ? 1 : 0) - c.sel) * k;
      c.act += ((c === this.selected || c === this.hovered ? 1 : 0) - c.act) * k;
    }
    const peak = this.findPeak();
    this.maxMgAnim += (Math.max(FLOOR_MG, peak.mg) - this.maxMgAnim) * (this.reduced ? 1 : 1 - Math.exp(-dt / 0.12));
    const rowsOf = (mg: number) => (mg / this.maxMgAnim) * FIT_ROWS;
    const yOf = (mg: number) => LY.row0 + 4 - rowsOf(mg) * CELL;

    const peakX = this.t2x(peak.t),
      bedX = this.t2x(S.bed);
    const bedMg = Math.round(this.totalAt(S.bed));
    const bl1 = "BED " + fmtT(S.bed),
      bl2 = bedMg + " MG STILL IN YOU";
    const bl2w = this.measure(bl2, 20);
    const bedFlip = bedX + 13 + bl2w > LW - 8;
    const peakLabel = "PEAK " + Math.round(peak.mg) + " MG";
    let peakVisible = cups.length > 0 && peak.mg > 1 && peak.t < S.bed;
    if (peakVisible) {
      peakVisible = bedFlip ? peakX + 13 + this.measure(peakLabel, 20) < bedX - 13 - bl2w - 24 : bedX - peakX > 0.287 * W;
    }
    this.peakAlpha += ((peakVisible ? 1 : 0) - this.peakAlpha) * k;
    this.bedAct += ((this.bedHover || this.bedDrag ? 1 : 0) - this.bedAct) * k;
    const blw = Math.max(bl2w, this.measure(bl1, 20)) + 13;
    this.bedBox = bedFlip ? { x0: bedX - blw, x1: bedX } : { x0: bedX, x1: bedX + blw };

    const order = [...cups].sort((a, b) => a.sel - b.sel || a.t - b.t);
    const cupCols = new Set(cups.map((c) => Math.round((this.t2x(c.t) - L - 4) / CELL)));

    ctx.setTransform((this.dpr * this.cw) / LW, 0, 0, (this.dpr * this.cw) / LW, 0, 0);
    ctx.fillStyle = rgba(BG, 1);
    ctx.fillRect(0, 0, LW, LH);

    // per-column data
    const mask = new Float32Array(COLS * MAXROWS);
    const colData: { x: number; t: number; rowsF: number; count: number; frac: number; topI: number; bounds: number[] }[] = new Array(COLS);
    for (let kk = 0; kk < COLS; kk++) {
      const x = this.colX(kk),
        t = this.x2t(x);
      const bounds: number[] = [];
      let cum = 0;
      for (const c of order) {
        cum += this.contrib(t - c.t, c.kind);
        bounds.push(rowsOf(cum));
      }
      const rowsF = rowsOf(cum);
      const nFull = Math.floor(rowsF),
        frac = rowsF - nFull;
      const count = Math.min(MAXROWS, nFull + (frac > 0.3 ? 1 : 0));
      let lastCup = -Infinity;
      for (const c of cups) if (c.t <= t && c.t > lastCup) lastCup = c.t;
      const topI = cupCols.has(kk) ? 0.78 : topIntensity(t - lastCup);
      colData[kk] = { x, t, rowsF, count, frac, topI, bounds };
      for (let r = 0; r < count; r++) mask[kk * MAXROWS + r] = 1;
    }

    // halo
    const near = blur(mask, 2, COLS),
      far = blur(mask, 14, COLS);
    for (let kk = 0; kk < COLS; kk++) {
      const x = this.colX(kk);
      for (let r = colData[kk].count; r < MAXROWS; r++) {
        const a = 0.12 * near[kk * MAXROWS + r] + 0.1 * far[kk * MAXROWS + r];
        if (a < 0.012) continue;
        this.dot(x, this.rowY(r), 1.05, rgba(WHITE, a));
      }
    }

    // filled dots, each layer tinted by its drink
    for (let kk = 0; kk < COLS; kk++) {
      const d = colData[kk];
      if (!d.count) continue;
      const topRow = Math.max(1, d.count - 1);
      let li = 0;
      for (let r = 0; r < d.count; r++) {
        while (li < d.bounds.length - 1 && d.bounds[li] < r + 0.5) li++;
        const lc = order[li];
        const sel = lc ? lc.sel * colorFresh(d.t - lc.t) : 0;
        const base = lc ? DRINK_INFO[lc.kind].color : WHITE;
        const I = 0.13 + (d.topI - 0.13) * Math.pow(r / topRow, 1.2);
        let rad = dotRadius(I);
        if (r === d.count - 1 && d.frac > 0.3 && d.frac < 1) rad *= 0.5 + 0.5 * d.frac;
        this.dot(d.x, this.rowY(r), rad, rgba(mix(base, BLUE, sel), lerp(I, Math.min(1, I * 1.25), sel)));
      }
    }

    // cup guide lines
    for (const c of cups) {
      const cx = this.t2x(c.t);
      const kk = Math.round((cx - L - 4) / CELL);
      const d = colData[kk];
      const active = Math.max(c.sel, c.act);
      const gcol = mix(WHITE, BLUE, active),
        galpha = lerp(0.22, 0.75, active);
      for (let y = yAxis + 3; y < yHandle - 11; y += CELL) this.dot(cx, y, 1, rgba(gcol, galpha));
      if (d && c.sel < 0.999) {
        for (let r = 0; r < d.count; r++) this.dot(d.x, this.rowY(r), 1.55, rgba(BG, 0.7 * (1 - c.sel)));
      }
      if (c.sel > 0.001) {
        let topRows = 0;
        for (let j = Math.max(0, kk); j < COLS; j++) {
          if (colData[j].t > c.t + 2.2) break;
          if (colData[j].rowsF > topRows) topRows = colData[j].rowsF;
        }
        const yTop = LY.row0 - CELL * Math.max(0, Math.round(topRows) - 1);
        for (let y = yAxis - 5; y >= yTop; y -= CELL) this.dot(cx, y, 1.2, rgba(BLUE, 0.85 * c.sel));
      }
    }

    // axis
    ctx.strokeStyle = "rgba(255,255,255,0.17)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, yAxis);
    ctx.lineTo(R, yAxis);
    ctx.stroke();
    for (let h = 0; h <= HOURS; h += 3) {
      const x = Math.round(this.t2x(S.start + h)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, yAxis - 4);
      ctx.lineTo(x, yAxis + 4);
      ctx.stroke();
      if (h % 6 === 0) this.text(String((S.start + h) % 24).padStart(2, "0"), x, LY.yAxisLabels, 20, "rgba(255,255,255,0.2)", "center");
    }

    // sleep limit line
    const yT = yOf(S.limit);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.moveTo(L, Math.round(yT) + 0.5);
    ctx.lineTo(R, Math.round(yT) + 0.5);
    ctx.stroke();
    ctx.restore();
    this.text(String(S.limit), R + 13, yT + 5, 20, "rgba(255,255,255,0.42)");

    // bed line + labels
    const ba = this.bedAct;
    ctx.strokeStyle = rgba(mix(WHITE, BLUE, ba), lerp(0.4, 0.9, ba));
    ctx.lineWidth = 1 + ba;
    ctx.beginPath();
    ctx.moveTo(Math.round(bedX) + 0.5, lineTop);
    ctx.lineTo(Math.round(bedX) + 0.5, yAxis - 13);
    ctx.stroke();
    ctx.lineWidth = 1;
    // grab knob at the foot of the bed line
    this.dot(bedX, yAxis - 13, 4 + 2 * ba, rgba(mix([180, 180, 180], BLUE, ba), 1));
    this.text(bl1, bedX + (bedFlip ? -13 : 13), label1, 20, ba > 0.01 ? rgba(mix([244, 244, 244], BLUE, ba), 1) : "#f4f4f4", bedFlip ? "right" : "left");
    this.text(bl2, bedX + (bedFlip ? -13 : 13), label2, 20, "#dbdbdb", bedFlip ? "right" : "left");

    // peak marker
    if (this.peakAlpha > 0.01) {
      const pa = this.peakAlpha;
      const kk = clamp(Math.round((peakX - L - 4) / CELL), 0, COLS - 1);
      const yTop = this.rowY(Math.max(0, colData[kk].count - 1)) - 10;
      ctx.strokeStyle = `rgba(255,255,255,${0.2 * pa})`;
      ctx.beginPath();
      ctx.moveTo(Math.round(peakX) + 0.5, lineTop);
      ctx.lineTo(Math.round(peakX) + 0.5, Math.min(yTop, yAxis - 13));
      ctx.stroke();
      this.text(peakLabel, peakX + 13, label1, 20, `rgba(244,244,244,${pa})`);
      this.text(fmtT(peak.t), peakX + 13, label2, 20, `rgba(115,115,115,${pa})`);
    }

    // handles + labels
    for (const c of cups) {
      const cx = this.t2x(c.t),
        active = Math.max(c.sel, c.act);
      this.dot(cx, yHandle, 8 + 2.5 * active, rgba(mix(DRINK_INFO[c.kind].handle, BLUE, active), 1));
      if (active > 0.01) this.text(`${c.kind.toUpperCase()} ${fmtT(c.t)}`, cx, yHandle + 27, 20, rgba(BLUE, active), "center");
    }

    // readout at the pointer
    const p = this.pointer;
    if (p && !this.hovered && !this.drag && !this.bedHover && !this.bedDrag && p.x >= L && p.x <= R && p.y >= lineTop - 60 && p.y <= yAxis) {
      const t = this.x2t(p.x),
        mg = this.totalAt(t);
      const y = yOf(mg);
      const str = fmtT(t) + " · " + Math.round(mg) + " MG";
      const flip = p.x + 15 + this.measure(str, 20) > LW - 8;
      this.dot(p.x, y, 4, "#e6e6e6");
      this.text(str, p.x + (flip ? -15 : 15), y - 18, 20, "#e6e6e6", flip ? "right" : "left");
    }

    // header / footer
    this.text("CAFFEINE", LY.padX, LY.titleY, 22, "#f3f3f3", "left", 500);
    const nC = cups.filter((c) => c.kind === "coffee").length,
      nM = cups.length - nC;
    const total = nC * S.coffeeDose + nM * S.matchaDose;
    const hl = Number.isInteger(S.halfLife) ? S.halfLife : S.halfLife.toFixed(1);
    const parts: string[] = [];
    if (nC) parts.push(`${nC} ${noun("coffee", nC)}`);
    if (nM) parts.push(`${nM} ${noun("matcha", nM)}`);
    if (!parts.length) parts.push("NOTHING YET");
    const sub = `${parts.join(" + ")} · ${total} MG · HALF-LIFE ${hl}H`;
    // colour each drink count in its own tint on wide layouts
    let x = LY.padX;
    const seg = (s: string, col: string) => {
      this.text(s, x, LY.subY, 20, col);
      x += this.measure(s, 20);
    };
    if (nC) seg(`${nC} ${noun("coffee", nC)}`, "#9a9a9a");
    if (nC && nM) seg(" + ", "#717171");
    if (nM) seg(`${nM} ${noun("matcha", nM)}`, rgba(DRINK_INFO.matcha.color, 0.85));
    seg(sub.slice(parts.join(" + ").length), "#717171");
    // footer status on the left, credit (HTML, on the footY baseline) on the right; stack them when they don't fit side by side
    const foot = this.footerText();
    const fits = LY.padX + this.measure(foot, 20) + 40 + this.measure(CREDIT.text.toUpperCase(), CREDIT_SIZE) <= LY.LW - LY.padX;
    this.text(foot, LY.padX, fits ? LY.footY : LY.footY - 30, 20, "#d8d8d8");
  }

  // ---------- interaction ----------
  private toLogical(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.LY.LW / r.width;
    return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s };
  }
  private hitBed(p: { x: number; y: number }) {
    const LY = this.LY;
    const bedX = this.t2x(this.S.bed);
    const onLine = Math.abs(p.x - bedX) <= Math.max(12, 16 / LY.u) && p.y >= LY.label1 - 26 && p.y <= LY.yAxis;
    const onLabel = p.x >= this.bedBox.x0 && p.x <= this.bedBox.x1 && p.y >= LY.label1 - 26 && p.y <= LY.label2 + 10;
    return onLine || onLabel;
  }
  private setCursor() {
    this.canvas.style.cursor = this.bedDrag || this.bedHover ? "ew-resize" : this.drag ? "grabbing" : this.hovered ? "grab" : "";
  }
  private hitCup(p: { x: number; y: number }) {
    const LY = this.LY;
    const hitR = Math.max(16, 24 / LY.u);
    for (const c of this.cups) if (Math.hypot(p.x - this.t2x(c.t), p.y - LY.yHandle) <= hitR) return c;
    if (p.y < LY.yAxis && p.y > LY.lineTop - 60 && p.x >= LY.L && p.x <= LY.R) {
      const t = this.x2t(p.x);
      let best: Cup | null = null;
      for (const c of this.cups) {
        if (t >= c.t - 0.05 && t <= c.t + 1.4 && (!best || c.t > best.t)) {
          const yTop = LY.row0 + 4 - (this.totalAt(t) / this.maxMgAnim) * FIT_ROWS * CELL;
          if (p.y >= yTop - 8) best = c;
        }
      }
      return best;
    }
    return null;
  }

  private bindEvents() {
    const cv = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(ev, fn as EventListener);
      this.cleanup.push(() => el.removeEventListener(ev, fn as EventListener));
    };
    on(window, "resize", this.resize);

    on(cv, "pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      cv.focus({ preventScroll: true });
      const p = this.toLogical(e);
      this.pointer = p;
      const LY = this.LY;
      if (this.hitBed(p)) {
        this.bedDrag = { offset: this.x2t(p.x) - this.S.bed };
        this.bedHover = true;
        this.selected = this.hovered = null;
        this.setCursor();
        this.emit();
        return;
      }
      const c = this.hitCup(p);
      if (c) {
        this.drag = { cup: c, offset: this.x2t(p.x) - c.t, wasSelected: this.selected === c, moved: false, sx: p.x, sy: p.y };
        this.selected = c;
        this.hovered = c;
        this.emit();
      } else if (p.x >= LY.L && p.x <= LY.R && p.y >= LY.lineTop - 60 && p.y <= LY.yHandle + 20) {
        this.pending = { sx: p.x, sy: p.y, moved: false };
      }
    });
    on(cv, "pointermove", (e) => {
      const p = this.toLogical(e);
      this.pointer = p;
      if (this.bedDrag) {
        const S = this.S;
        const bed = clamp(Math.round((this.x2t(p.x) - this.bedDrag.offset) * 4) / 4, S.start + 10, S.start + 23.75);
        if (bed !== S.bed) {
          this.S = { ...S, bed };
          this.emit();
        }
        return;
      }
      if (this.drag) {
        if (Math.hypot(p.x - this.drag.sx, p.y - this.drag.sy) > 3) this.drag.moved = true;
        const t = clamp(this.x2t(p.x) - this.drag.offset, this.S.start, this.S.start + HOURS - 1 / 60);
        this.drag.cup.t = Math.round(t * 60) / 60;
        return;
      }
      if (this.pending) {
        if (Math.hypot(p.x - this.pending.sx, p.y - this.pending.sy) > 6) this.pending.moved = true;
        return;
      }
      this.bedHover = this.hitBed(p);
      this.hovered = this.bedHover ? null : this.hitCup(p);
      this.setCursor();
    });
    const endPointer = (e: PointerEvent) => {
      const p = this.toLogical(e);
      this.pointer = p;
      const touch = e.pointerType === "touch";
      const LY = this.LY;
      if (this.bedDrag) {
        this.bedDrag = null;
        this.save();
        this.announce(`Bed time ${fmtT(this.S.bed)}. ${Math.round(this.totalAt(this.S.bed))} mg at bed.`);
        this.emit();
      } else if (this.drag) {
        const d = this.drag;
        if (!d.moved && d.wasSelected) {
          this.cups = this.cups.filter((c) => c !== d.cup);
          if (this.selected === d.cup) this.selected = null;
          this.hovered = null;
          this.announce(`${DRINK_INFO[d.cup.kind].label} removed.`);
        } else {
          this.announce(`${DRINK_INFO[d.cup.kind].label} at ${fmtT(d.cup.t)}. ${Math.round(this.totalAt(this.S.bed))} mg at bed.`);
        }
        this.drag = null;
        this.save();
        this.emit();
      } else if (this.pending) {
        if (!this.pending.moved && this.cups.length < MAX_CUPS && p.x >= LY.L && p.x <= LY.R) {
          const t = Math.round(clamp(this.x2t(p.x), this.S.start, this.S.start + HOURS - 1 / 60) * 60) / 60;
          const c: Cup = { t, kind: this.drink, sel: 0, act: 0 };
          this.cups.push(c);
          this.hovered = c;
          this.save();
          this.announce(`${DRINK_INFO[c.kind].label} added at ${fmtT(t)}.`);
          this.emit();
        }
        this.pending = null;
      }
      if (touch) {
        this.pointer = null;
        this.hovered = null;
        this.bedHover = false;
      } else {
        this.bedHover = this.hitBed(p);
        this.hovered = this.bedHover ? null : this.hitCup(p);
      }
      this.setCursor();
    };
    on(cv, "pointerup", endPointer);
    on(cv, "pointercancel", () => {
      this.drag = this.pending = this.bedDrag = null;
      this.pointer = this.hovered = null;
      this.bedHover = false;
    });
    on(cv, "pointerleave", () => {
      if (!this.drag && !this.bedDrag) {
        this.pointer = this.hovered = null;
        this.bedHover = false;
      }
    });
    on(cv, "keydown", (e) => {
      if (e.key === "Escape") {
        this.selected = null;
        this.emit();
      } else if ((e.key === "Backspace" || e.key === "Delete") && this.selected) {
        this.cups = this.cups.filter((c) => c !== this.selected);
        this.selected = this.hovered = null;
        this.save();
        this.announce("Drink removed.");
        this.emit();
      } else if (this.selected && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const step = (e.shiftKey ? 1 : 0.25) * (e.key === "ArrowLeft" ? -1 : 1);
        this.selected.t = clamp(this.selected.t + step, this.S.start, this.S.start + HOURS - 1 / 60);
        this.save();
        e.preventDefault();
      } else if (e.key === "c" || e.key === "m") {
        this.setDrink(e.key === "c" ? "coffee" : "matcha");
      }
    });
  }
}
