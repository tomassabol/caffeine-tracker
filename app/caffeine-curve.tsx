"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CurveEngine, MAX_CUPS } from "@/lib/engine";
import { DRINK_INFO, DRINKS, FIELD_GROUPS, fieldRange, fmtT, clamp, type Field, type Settings } from "@/lib/model";

export function CaffeineCurve({ font }: { font: string }) {
  const [engine] = useState(() => new CurveEngine(font));
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [spin, setSpin] = useState(0);

  useEffect(() => engine.mount(canvasRef.current!, stageRef.current!), [engine]);

  useEffect(() => {
    if (!cfgOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCfgOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [cfgOpen]);

  const { count, drink, selectedKind, settings } = snap;

  return (
    <>
      <div className="stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="Caffeine level through the day. Drag a drink to move it, drag the bed line to change bed time, tap the chart to add the highlighted drink, tap a selected drink to remove it. Press C or M to change the selected drink."
        />
        <div className="tools">
          {DRINKS.map((d) => {
            const n = snap[d];
            const name = DRINK_INFO[d].label.toLowerCase();
            const convert = selectedKind != null && selectedKind !== d;
            return (
              <div key={d} className={`counter counter-${d}`} role="group" aria-label={`${DRINK_INFO[d].label} count`}>
                <button
                  type="button"
                  className="counter-label"
                  aria-pressed={drink === d}
                  title={convert ? `Change the selected drink to ${name}` : `Tapping the chart adds ${name}`}
                  onClick={() => engine.setDrink(d)}
                >
                  <span className="swatch" style={{ background: `rgb(${DRINK_INFO[d].handle.join(",")})` }} />
                  {d.toUpperCase()}
                </button>
                <button className="tool" type="button" aria-label={`Remove a ${name}`} title={`One ${name} less`} disabled={n === 0} onClick={() => engine.removeCup(d)}>
                  −
                </button>
                <output aria-live="polite">{n}</output>
                <button className="tool" type="button" aria-label={`Add a ${name}`} title={`One ${name} more`} disabled={count >= MAX_CUPS} onClick={() => engine.addCup(d)}>
                  +
                </button>
              </div>
            );
          })}
          <div className="icons">
            <button
              key={spin}
              className={`tool${spin ? " spin" : ""}`}
              type="button"
              title="Reset drinks"
              aria-label="Reset drinks to the defaults"
              onClick={() => {
                engine.resetCups();
                setSpin((s) => s + 1);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            <button
              className="tool"
              type="button"
              title="Settings"
              aria-label="Settings"
              aria-expanded={cfgOpen}
              aria-controls="cfg"
              onClick={() => setCfgOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
                <path d="M14 2v4M8 10v4M16 18v4" />
              </svg>
            </button>
          </div>
        </div>

        {cfgOpen && (
          <section className="cfg" id="cfg" aria-label="Settings">
            {FIELD_GROUPS.map((g) => (
              <div key={g.title} className="group">
                <h2>{g.title}</h2>
                {g.fields.map((f) => (
                  <FieldRow key={f.k} field={f} settings={settings} onSet={(v) => engine.setSetting(f.k, v)} />
                ))}
              </div>
            ))}
            <div className="cfg-foot">
              <p className="hint">Saved in this browser. Typical: coffee 95 mg, matcha 65 mg (2 g), peak 45 min, half-life 5 h. Your half-life may be 2–10 h.</p>
              <button className="reset" type="button" onClick={() => engine.resetSettings()}>
                Defaults
              </button>
            </div>
          </section>
        )}
      </div>
      <p className="sr" aria-live="polite">
        {snap.status}
      </p>
    </>
  );
}

function FieldRow({ field: f, settings, onSet }: { field: Field; settings: Settings; onSet: (v: number) => void }) {
  const value = settings[f.k];
  const shown = f.time ? fmtT(value) : String(+value.toFixed(2));
  const [draft, setDraft] = useState<string | null>(null);

  const set = (v: number) => {
    if (!Number.isFinite(v)) return;
    const [lo, hi] = fieldRange(f, settings);
    onSet(clamp(Math.round(v / f.step) * f.step, lo, hi));
  };
  const bump = (dir: number) => set(value + dir * f.step);
  const id = `f-${f.k}`;

  return (
    <div className="row">
      <label className="lbl" htmlFor={id}>
        {f.label}
        <span className="sub">{f.sub}</span>
      </label>
      <div className="ctl">
        <button type="button" aria-label={`${f.label} down`} onClick={() => bump(-1)}>
          −
        </button>
        {f.time ? (
          <input
            id={id}
            type="text"
            readOnly
            aria-live="polite"
            value={shown}
            onKeyDown={(e) => {
              const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
              if (dir) {
                bump(dir);
                e.preventDefault();
              }
            }}
          />
        ) : (
          <input
            id={id}
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            step={f.step}
            value={draft ?? shown}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft != null) set(parseFloat(draft));
              setDraft(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        )}
        <span className="unit">{f.unit.toUpperCase()}</span>
        <button type="button" aria-label={`${f.label} up`} onClick={() => bump(1)}>
          +
        </button>
      </div>
    </div>
  );
}
