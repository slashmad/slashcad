import { useEffect, useRef, useState } from "react";
import type { BuildResult, BuildState, ProjectInfo, Settings } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";
import type { NavTool } from "../viewer/navigation";
import type { DisplayMode, SectionAxis, Selection, TransformMode, Viewer } from "../viewer/Viewer";

interface Props {
  viewer: Viewer | null;
  mountRef: React.RefObject<HTMLDivElement | null>;
  build: BuildResult | null;
  buildState: BuildState;
  info: ProjectInfo | null;
  settings: Settings;
  displayBackend: string;
  selection: Selection | null;
  toast: string | null;
  onOpenSource(path: string, line: number | null): void;
  onAskAgent(chip: string): void;
  onAddAnnotation(sel: Selection): void;
  onHide(id: string): void;
  onIsolate(id: string): void;
  onProjection(p: "perspective" | "orthographic"): void;
  onTheme(t: "dark" | "light"): void;
  onShowAll(): void;
}


export function ViewerPane(p: Props) {
  const t = useT();
  const v = p.viewer;
  const [ctx, setCtx] = useState<{ x: number; y: number; hit: Selection | null } | null>(null);
  const [mode, setMode] = useState<DisplayMode>("shaded-edges");
  const [section, setSection] = useState<{ axis: SectionAxis; offset: number; flip: boolean }>({ axis: null, offset: 0.5, flip: false });
  const [measure, setMeasure] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [before, setBefore] = useState(false);
  const [tool, setToolState] = useState<NavTool>("select");
  const [fps, setFps] = useState(0);
  const [errOpen, setErrOpen] = useState(true);
  const [menu, setMenu] = useState<"export" | "views" | "display" | null>(null);
  const [, force] = useState(0);
  const [xform, setXform] = useState<{ mode: TransformMode; id: string } | null>(null);
  const lastErrBuild = useRef(0);

  useEffect(() => {
    if (!v) return;
    v.onFrame = (f) => setFps(f);
    v.onMeasure = (d) => setMeasure(d ? `${d.dist.toFixed(3)} mm` : null);
    v.onTransformChange = (t) => setXform(t);
    v.onContextMenu = (x, y, hit) => {
      const r = p.mountRef.current?.getBoundingClientRect();
      setCtx({ x: x - (r?.left ?? 0), y: y - (r?.top ?? 0), hit });
    };
  }, [v]);

  const setTool = (t: NavTool) => { v?.setTool(t); setToolState(t); };
  const toggleProjection = () => {
    if (!v) return;
    const next = v.projection === "perspective" ? "orthographic" : "perspective";
    v.setProjection(next);
    p.onProjection(next);
    force((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!v || (e.target instanceof Element && e.target.closest("textarea, input, select"))) return;
      const k = e.key.toLowerCase();
      if (k === "f") v.fit(v.selection ? [v.selection.partId] : undefined);
      else if (k === "h" || e.key === "Home" || k === "0") v.setView("iso", true, true);
      else if (k === "1") v.setView("front");
      else if (k === "3") v.setView("right");
      else if (k === "7") v.setView("top");
      else if (k === "5") toggleProjection();
      else if (k === "m") { const on = !v.measuring; v.setMeasuring(on); setMeasuring(on); }
      else if (k === "p" && v.selection) p.onAddAnnotation(v.selection);
      else if (k === "r") setTool(tool === "orbit" ? "select" : "orbit");
      else if (e.key === "Escape") {
        if (v.transforming) { v.stopTransform(); return; }
        v.select(null); setTool("select"); if (v.measuring) { v.setMeasuring(false); setMeasuring(false); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const errors = p.build?.sources.filter((s) => s.error) ?? [];
  useEffect(() => {
    if (p.build && p.build.n !== lastErrBuild.current && errors.length) { setErrOpen(true); lastErrBuild.current = p.build.n; }
  }, [p.build]);

  const setSec = (s: typeof section) => { setSection(s); v?.setSection(s.axis, s.offset, s.flip); };
  const sel = p.selection;
  // Stop moving when another part is selected or the selection is cleared.
  useEffect(() => { if (v?.transforming && sel?.partId !== v.transforming.id) v.stopTransform(); }, [sel?.partId]);
  const toggleXform = (mode: TransformMode, id: string) => {
    if (!v) return;
    if (v.transforming?.mode === mode && v.transforming.id === id) v.stopTransform(); else v.startTransform(mode, id);
  };
  const placed = (id: string) => !!p.info?.placements?.[id];
  const selPart = sel ? p.build?.parts.find((x) => x.id === sel.partId) : null;
  const dims = selPart ? selPart.bbox[1].map((x, i) => (x - selPart.bbox[0][i]).toFixed(2)).join(" × ") : "";
  const modeLabel: Record<DisplayMode, string> = { "shaded-edges": t("mode.shaded-edges"), shaded: t("mode.shaded"), wire: t("mode.wire"), xray: t("mode.xray") };

  return (
    <div className="viewer-pane">
      <div className={`viewport theme-${p.settings.theme}`} ref={p.mountRef} />

      <div className="vtoolbar">
        <span className="group">
          {t("vp.section")}
          {(["x", "y", "z"] as const).map((a) => (
            <button key={a} className={section.axis === a ? "on" : ""} onClick={() => setSec({ ...section, axis: section.axis === a ? null : a })}>{a.toUpperCase()}</button>
          ))}
          {section.axis && <>
            <input type="range" min={0} max={1} step={0.001} value={section.offset} onChange={(e) => setSec({ ...section, offset: Number(e.target.value) })} />
            <button title={t("vp.flip")} onClick={() => setSec({ ...section, flip: !section.flip })}>⇄</button>
          </>}
        </span>
        <span className="sep" />
        <button className={measuring ? "on" : ""} title={t("vp.measureTitle")} onClick={() => { const on = !measuring; v?.setMeasuring(on); setMeasuring(on); }}>{t("vp.measure")}</button>
        <button className={before ? "on" : ""} title={t("vp.beforeTitle")} onClick={() => { v?.setShowBefore(!before); setBefore(!before); }}>{t("vp.before")}</button>
        <span className="sep" />
        <select value={p.info?.quality ?? "normal"} title={t("vp.quality")} onChange={(e) => api.project.setQuality(e.target.value)}>
          <option value="draft">{t("vp.draft")}</option>
          <option value="normal">{t("vp.normal")}</option>
          <option value="fine">{t("vp.fine")}</option>
        </select>
        <button title={t("vp.buildTitle")} onClick={() => api.cad.build()}>{t("vp.build")}</button>
        <span className="menu-wrap">
          <button onClick={() => setMenu(menu === "export" ? null : "export")}>{t("vp.export")}</button>
          {menu === "export" && (
            <div className="menu" onMouseLeave={() => setMenu(null)}>
              {["step", "stl", "glb", "brep"].map((f) => <div key={f} className="menu-item" onClick={() => { setMenu(null); api.cad.export(f); }}>{t("vp.exportAll", { f: f.toUpperCase() })}</div>)}
              {sel && ["step", "stl"].map((f) => <div key={"s" + f} className="menu-item" onClick={() => { setMenu(null); api.cad.export(f, [sel.partId]); }}>{t("vp.exportSel", { f: f.toUpperCase() })}</div>)}
            </div>
          )}
        </span>
      </div>

      {ctx && (() => {
        const part = ctx.hit ? p.build?.parts.find((x) => x.id === ctx.hit!.partId) : null;
        const item = (label: string, fn: () => void, cls = "") => <div className={`menu-item ${cls}`} onClick={() => { setCtx(null); fn(); }}>{label}</div>;
        return (
          <div className="ctx-back" onPointerDown={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
            <div className="menu ctx" style={{ left: ctx.x, top: ctx.y }} onPointerDown={(e) => e.stopPropagation()}>
              {part && ctx.hit && <>
                <div className="menu-title">{part.name}{ctx.hit.face >= 0 ? ` · face ${ctx.hit.face}` : ""}</div>
                {item(t("ctx.mark"), () => p.onAddAnnotation(ctx.hit!), "strong")}
                {item(t("ctx.ask"), () => p.onAskAgent(`part "${part.name}" (id ${part.id}), face ${ctx.hit!.face}, point (${ctx.hit!.point.x.toFixed(2)}, ${ctx.hit!.point.y.toFixed(2)}, ${ctx.hit!.point.z.toFixed(2)}) mm`))}
                {item(t("ctx.fitPart"), () => v?.fit([part.id]))}
                <div className="menu-sep" />
                {item(t("ctx.move"), () => { v?.selectPart(part.id); v?.startTransform("move", part.id); })}
                {item(t("ctx.rotate"), () => { v?.selectPart(part.id); v?.startTransform("rotate", part.id); })}
                {ctx.hit.face >= 0 && ctx.hit.normal && item(t("ctx.layFlat"), () => v?.layFlat(part.id, ctx.hit!.normal!))}
                {item(t("ctx.drop"), () => v?.dropToBed(part.id))}
                {placed(part.id) && item(t("ctx.resetPlace"), () => v?.resetPlacement(part.id))}
                <div className="menu-sep" />
                {item(t("ctx.hide"), () => p.onHide(part.id))}
                {item(t("ctx.isolate"), () => p.onIsolate(part.id))}
                {item(t("ctx.source"), () => p.onOpenSource(part.source, null))}
                <div className="menu-sep" />
              </>}
              {item(t("ctx.home"), () => v?.setView("iso", true, true))}
              {item(t("ctx.fitAll"), () => v?.fit())}
              {item(t("ctx.showAll"), () => p.onShowAll())}
            </div>
          </div>
        );
      })()}

      {p.info && !p.info.trusted && (p.info.scripts?.length ?? 0) > 0 && (
        <div className="trust-banner">
          {t(p.info.singleFile ? "trust.single" : "trust.folder", { n: p.info.scripts!.length })}
          <button className="primary" onClick={() => api.project.trust()}>{t(p.info.singleFile ? "trust.run" : "trust.button")}</button>
        </div>
      )}

      {p.build?.preview && (
        <div className="pose-banner">
          {t("vp.posePreview", { param: p.build.preview.param, value: p.build.preview.value, file: p.build.preview.file })}
          <button className="primary" onClick={() => api.checks.preview(null)}>{t("vp.backToFile")}</button>
        </div>
      )}

      {measuring && <div className="hint">{t("vp.measureHint", { m: measure ? ` · ${measure}` : "" })}</div>}
      {xform && !measuring && <div className="hint low">{t(xform.mode === "move" ? "vp.moveHint" : "vp.rotateHint")}</div>}
      {p.toast && <div className="toast">{p.toast}</div>}

      {selPart && sel && (
        <div className="sel-card">
          <div className="sel-name">{selPart.name}</div>
          <div className="muted small">{selPart.source}{sel.face >= 0 ? ` · ${t("vp.face", { n: sel.face })}` : ""} · {dims} mm{placed(selPart.id) ? ` · ${t("vp.placed")}` : ""}</div>
          <div className="sel-actions">
            <button className="primary" title={t("vp.markTitle")} onClick={() => p.onAddAnnotation(sel)}>{t("vp.mark")}</button>
            <button onClick={() => p.onAskAgent(`part "${selPart.name}" (id ${selPart.id})${sel.face >= 0 ? `, face ${sel.face}` : ""}, point (${sel.point.x.toFixed(2)}, ${sel.point.y.toFixed(2)}, ${sel.point.z.toFixed(2)}) mm`)}>{t("vp.ask")}</button>
            <button onClick={() => v?.fit([selPart.id])}>{t("vp.zoom")}</button>
            <button onClick={() => p.onHide(selPart.id)}>{t("vp.hide")}</button>
            <button onClick={() => p.onIsolate(selPart.id)}>{t("vp.isolate")}</button>
            <button onClick={() => p.onOpenSource(selPart.source, null)}>{t("vp.source")}</button>
          </div>
          <div className="sel-actions">
            <button className={xform?.mode === "move" && xform.id === selPart.id ? "on" : ""} onClick={() => toggleXform("move", selPart.id)}>{t("vp.move")}</button>
            <button className={xform?.mode === "rotate" && xform.id === selPart.id ? "on" : ""} onClick={() => toggleXform("rotate", selPart.id)}>{t("vp.rotate")}</button>
            {sel.face >= 0 && sel.normal && <button title={t("vp.layFlatTitle")} onClick={() => v?.layFlat(selPart.id, sel.normal!)}>{t("vp.layFlat")}</button>}
            <button title={t("vp.dropTitle")} onClick={() => v?.dropToBed(selPart.id)}>{t("vp.drop")}</button>
            {placed(selPart.id) && <button onClick={() => v?.resetPlacement(selPart.id)}>{t("vp.resetPlace")}</button>}
          </div>
        </div>
      )}

      {errors.length > 0 && errOpen && (
        <div className="err-panel">
          <div className="err-head">{t("vp.errors", { n: errors.length })} <button onClick={() => setErrOpen(false)}>×</button></div>
          {errors.map((s) => (
            <details key={s.source} open>
              <summary className="err-src" onClick={(e) => { e.preventDefault(); p.onOpenSource(s.source, s.error!.line); }}>{s.source}{s.error!.line ? `:${s.error!.line}` : ""} – {s.error!.message}</summary>
              {s.error!.traceback && <pre className="tb">{s.error!.traceback.split("\n").slice(-14).join("\n")}</pre>}
            </details>
          ))}
        </div>
      )}

      <div className="navbar">
        <button className={tool === "select" ? "on" : ""} title={t("vp.select")} onClick={() => setTool("select")}>⬉</button>
        <button className={tool === "orbit" ? "on" : ""} title={t("vp.orbitTool")} onClick={() => setTool(tool === "orbit" ? "select" : "orbit")}>⟳</button>
        <button className={tool === "pan" ? "on" : ""} title={t("vp.panTool")} onClick={() => setTool(tool === "pan" ? "select" : "pan")}>✥</button>
        <button className={tool === "zoom" ? "on" : ""} title={t("vp.zoomTool")} onClick={() => setTool(tool === "zoom" ? "select" : "zoom")}>⌕</button>
        <span className="sep" />
        <button title={t("vp.fit")} onClick={() => v?.fit()}>⤢</button>
        <button title={t("vp.home")} onClick={() => v?.setView("iso", true, true)}>⌂</button>
        <span className="menu-wrap up">
          <button title={t("vp.viewsTitle")} onClick={() => setMenu(menu === "views" ? null : "views")}>{t("vp.views")}</button>
          {menu === "views" && (
            <div className="menu" onMouseLeave={() => setMenu(null)}>
              {(["iso", "front", "back", "left", "right", "top", "bottom"] as const).map((k) => (
                <div key={k} className="menu-item" onClick={() => { setMenu(null); v?.setView(k); }}>{t(`view.${k}`)}</div>
              ))}
            </div>
          )}
        </span>
        <button title={t("vp.projTitle")} onClick={toggleProjection}>{v?.projection === "orthographic" ? t("vp.ortho") : t("vp.persp")}</button>
        <span className="menu-wrap up">
          <button title={t("vp.displayTitle")} onClick={() => setMenu(menu === "display" ? null : "display")}>{modeLabel[mode]} ▴</button>
          {menu === "display" && (
            <div className="menu" onMouseLeave={() => setMenu(null)}>
              {(Object.keys(modeLabel) as DisplayMode[]).map((m) => (
                <div key={m} className={`menu-item ${m === mode ? "cur" : ""}`} onClick={() => { setMenu(null); setMode(m); v?.setMode(m); }}>{modeLabel[m]}</div>
              ))}
            </div>
          )}
        </span>
        <span className="sep" />
        <button title={t("vp.themeTitle")} onClick={() => p.onTheme(p.settings.theme === "dark" ? "light" : "dark")}>◐</button>
      </div>

      <div className="statusbar">
        <span className={`st ${p.buildState.running ? "run" : errors.length ? "bad" : "ok"}`}>
          {!p.buildState.workerReady ? (p.buildState.workerError ? t("st.worker", { e: p.buildState.workerError }) : t("st.startingWorker"))
            : p.buildState.running ? <><span className="spinner" /> {p.buildState.message ?? t("st.building")}{p.buildState.queued ? t("st.queued") : ""}</>
            : p.build ? t("st.build", { n: p.build.n, s: p.build.seconds.toFixed(2), p: p.build.parts.length }) + (errors.length ? t("st.withErrors", { n: errors.length }) : "")
            : t("st.ready")}
        </span>
        {errors.length > 0 && !errOpen && <button className="link bad" onClick={() => setErrOpen(true)}>{t("st.showErrors")}</button>}
        {!p.buildState.workerReady && p.buildState.workerError && <button className="link" onClick={() => api.cad.restartWorker()}>{t("st.restart")}</button>}
        <span className="grow" />
        <span className="muted">{t(`nav.hint.${p.settings.navigation}`)} · {p.displayBackend}{fps ? ` · ${fps.toFixed(0)} fps` : ""}</span>
      </div>
    </div>
  );
}
