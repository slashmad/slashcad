// Named parameters from the shown scripts. Type a value, use arrow keys, or drag the name
// sideways to scrub; the file is rewritten and the model rebuilds live.
import { useEffect, useRef, useState } from "react";
import type { Param } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";

function stepFor(p: Param): number {
  if (p.integer) return 1;
  const mag = Math.abs(p.value) || 1;
  return Math.pow(10, Math.floor(Math.log10(mag)) - 1);
}

function fmt(v: number, p: Param): string {
  return p.integer ? String(Math.round(v)) : String(Number(v.toPrecision(10)));
}

function ParamRow({ p }: { p: Param }) {
  const [text, setText] = useState(fmt(p.value, p));
  const [busy, setBusy] = useState(false);
  const last = useRef(p.value);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { if (!busy) setText(fmt(p.value, p)); last.current = p.value; }, [p.value]);

  const commit = (v: number, delay = 0) => {
    if (!Number.isFinite(v) || v === last.current) return;
    last.current = v;
    setText(fmt(v, p));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.params.set(p.file, p.line, p.name, v).catch((e: any) => alert(e?.message ?? String(e)));
    }, delay);
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, v0 = Number(text), step = stepFor(p);
    setBusy(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const v = v0 + Math.round((ev.clientX - x0) / 4) * step * k;
      commit(p.integer ? Math.round(v) : v, 180);
    };
    const up = () => { setBusy(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="param-row" title={`${p.file}:${p.line}${p.comment ? ` – ${p.comment}` : ""}`}>
      <span className="param-name" onPointerDown={scrub}>{p.name}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(Number(text.replace(",", ".")))}
        onKeyDown={(e) => {
          const step = stepFor(p) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
          if (e.key === "Enter") commit(Number(text.replace(",", ".")));
          else if (e.key === "ArrowUp") { e.preventDefault(); commit(Number(text) + step, 120); }
          else if (e.key === "ArrowDown") { e.preventDefault(); commit(Number(text) - step, 120); }
        }}
      />
      {p.comment && <span className="param-comment">{p.comment}</span>}
    </div>
  );
}

export function ParamsPanel({ params }: { params: Param[] }) {
  const t = useT();
  if (!params.length) {
    return (
      <div className="muted pad">
        {t("params.none")}
        <pre className="md-code">WIDTH = 120  # mm{"\n"}HOLES = 4</pre>
        {t("params.noneAfter")}
      </div>
    );
  }
  const files = [...new Set(params.map((p) => p.file))];
  return (
    <div className="params">
      <div className="muted small pad-x">{t("params.help")}</div>
      {files.map((f) => (
        <div key={f} className="mt-group">
          <div className="mt-src">{f}</div>
          {params.filter((p) => p.file === f).map((p) => <ParamRow key={`${p.file}:${p.name}`} p={p} />)}
        </div>
      ))}
    </div>
  );
}
