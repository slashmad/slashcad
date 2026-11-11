import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import type { AgentEvent, AgentKind, Annotation, BuildResult, BuildState, FileDiff, FileNode, HistoryState, McpActivity, Param, ProjectInfo, Settings, SnapshotRequest } from "../shared/types";
import { addActivity, initialAgent, reduce, type AgentState } from "./agentStore";
import { api } from "./api";
import { LangContext, translate } from "./i18n";
import { AgentPanel } from "./components/AgentPanel";
import { LeftPanel } from "./components/LeftPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { SourceDrawer } from "./components/SourceDrawer";
import { ViewerPane } from "./components/ViewerPane";
import { parseSmsh, type ParsedMesh } from "./viewer/smsh";
import { Viewer, type Selection } from "./viewer/Viewer";

type AgentAction = { t: "ev"; kind: AgentKind; ev: AgentEvent } | { t: "act"; a: McpActivity } | { t: "kind"; kind: AgentKind };

function agentReducer(s: AgentState, a: AgentAction): AgentState {
  if (a.t === "ev") return reduce(s, a.kind, a.ev);
  if (a.t === "act") return addActivity(s, a.a);
  return { ...s, kind: a.kind };
}

function useSplitter(initial: number, min: number, max: number, side: "left" | "right") {
  const [w, setW] = useState(() => {
    try { return Number(localStorage.getItem(`split-${side}`)) || initial; } catch { return initial; }
  });
  const start = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = w;
    const move = (ev: PointerEvent) => {
      const nw = Math.min(max, Math.max(min, side === "left" ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0)));
      setW(nw);
      try { localStorage.setItem(`split-${side}`, String(nw)); } catch { /* storage unavailable */ }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return [w, start] as const;
}

export function App() {
  const [appInfo, setAppInfo] = useState<any>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [history, setHistory] = useState<BuildResult[]>([]);
  const [buildState, setBuildState] = useState<BuildState>({ running: false, workerReady: false });
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [source, setSource] = useState<{ path: string; line: number | null } | null>(null);
  const [fileVersion, setFileVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeAnn, setActiveAnn] = useState<string | null>(null);
  const [params, setParams] = useState<Param[]>([]);
  const [agent, dispatch] = useReducer(agentReducer, initialAgent("claude"));
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [scInfo, setScInfo] = useState<any>(null);
  const [scMenu, setScMenu] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [undoState, setUndoState] = useState<HistoryState>({ undo: null, redo: null });
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  const placedFor = useRef<string | null>(null); // project whose placements the viewer has
  const langRef = useRef<"en" | "sv">("en");
  langRef.current = settings?.language ?? "en";
  const tr = (k: string, v?: Record<string, string | number>) => translate(langRef.current, k, v);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const meshCache = useRef(new Map<string, ParsedMesh>());
  const loadSeq = useRef(0);
  const [leftW, leftDrag] = useSplitter(270, 180, 560, "left");
  const [rightW, rightDrag] = useSplitter(420, 300, 760, "right");

  const showToast = useCallback((t: string, ms = 5000) => {
    setToast(t);
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(() => setToast(null), ms);
  }, []);

  // Viewer lifecycle.
  useEffect(() => {
    if (!mountRef.current) return;
    const v = new Viewer(mountRef.current);
    v.onSelect = (s) => setSelection(s);
    v.onPinClick = (id) => setActiveAnn(id);
    v.onPlacement = (id, m) => { api.placement.set(id, m); };
    // Pins sit at world points on a part: when the part moves, they move with it.
    v.onPlacementDelta = (id, delta) => {
      for (const a of annotationsRef.current) {
        if (a.partId !== id) continue;
        const point = new THREE.Vector3(...a.point).applyMatrix4(delta).toArray();
        const normal = a.normal ? new THREE.Vector3(...a.normal).transformDirection(delta).toArray() : null;
        api.annotations.update(a.id, { point, normal });
      }
    };
    (window as any).__viewer = v; // used by the main-process test hooks
    setViewer(v);
    return () => v.dispose();
  }, [!!appInfo && !!info && !!tree]); // the viewport exists only once the full layout renders

  useEffect(() => {
    if (viewer && settings) {
      viewer.setNavConfig({
        mapping: settings.navigation, rightDragOrbits: settings.rightDragOrbits, orbitStyle: settings.orbitStyle, orbitAround: settings.orbitAround,
        zoomToCursor: settings.zoomToCursor, reverseZoom: settings.reverseZoom, zoomSpeed: settings.zoomSpeed, smoothZoom: settings.smoothZoom,
        twoFingerPan: settings.twoFingerPan,
      });
      viewer.middleDoubleClick = settings.middleDoubleClick;
      viewer.animateViews = settings.animateViews;
      viewer.animationSpeed = settings.animationSpeed;
      viewer.fitSize = settings.fitSize;
      viewer.fitOnViewChange = settings.fitOnViewChange;
      viewer.setProjection(settings.projection);
      viewer.setTheme(settings.theme ?? "dark");
      viewer.setLanguage(settings.language ?? "en");
      viewer.ambientOcclusion = settings.ambientOcclusion !== false;
      viewer.requestRender();
    }
  }, [viewer, settings]);

  useEffect(() => { viewer?.setAnnotations(annotations, activeAnn); }, [viewer, annotations, activeAnn]);

  // Part placements: applied silently right after a project opens (pins are already stored placed).
  useEffect(() => {
    if (!viewer || !info) return;
    const fresh = placedFor.current !== info.dir;
    placedFor.current = info.dir;
    viewer.setPlacements(info.placements, fresh);
  }, [viewer, info?.dir, info?.placements]);

  const undo = useCallback(async (redo = false) => {
    const label = redo ? await api.history.redo() : await api.history.undo();
    showToast(label ? translate(langRef.current, redo ? "toast.redone" : "toast.undone", { what: label }) : translate(langRef.current, redo ? "app.nothingRedo" : "app.nothingUndo"), 2500);
  }, [showToast]);

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, except while typing (text fields keep their own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target instanceof Element && e.target.closest("textarea, input, select, [contenteditable=true]")) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); undo(e.shiftKey); }
      else if (k === "y") { e.preventDefault(); undo(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const importFiles = async (destDir?: string, paths?: string[]) => {
    try {
      const done = paths ? await api.project.importPaths(paths, destDir) : await api.project.importDialog(destDir);
      if (done.length) showToast(tr("toast.imported", { n: done.length, list: done.slice(0, 4).join(", ") + (done.length > 4 ? " …" : "") }), 4000);
    } catch (e: any) { showToast(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 6000); }
  };
  const deleteFiles = async (paths: string[]) => {
    try {
      const n = await api.project.remove(paths);
      if (n) showToast(tr("toast.deleted", { n }), 4000);
    } catch (e: any) { showToast(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 6000); }
  };

  // Apply a build: fetch only meshes we don't have, then swap parts in place.
  const applyBuild = useCallback(async (r: BuildResult, v: Viewer | null, first: boolean) => {
    setBuild(r);
    setHistory((h) => [...h.slice(-99), r]);
    if (!v) return;
    const seq = ++loadSeq.current;
    const missing = r.parts.filter((p) => !meshCache.current.has(p.key));
    let i = 0;
    const worker = async () => {
      while (i < missing.length) {
        const p = missing[i++];
        try { meshCache.current.set(p.key, parseSmsh(await api.cad.mesh(p.mesh))); } catch (e) { console.error("mesh", p.id, e); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
    if (seq !== loadSeq.current) return; // a newer build arrived meanwhile
    v.updateParts(r.parts, meshCache.current, { flash: !first });
    // Keep cache bounded to what is shown now.
    const live = new Set(r.parts.map((p) => p.key));
    for (const k of meshCache.current.keys()) if (!live.has(k)) meshCache.current.delete(k);
    const changed = r.parts.filter((p) => p.changed).length;
    if (!first && changed && r.trigger !== "opened") showToast(tr("toast.partsChanged", { n: changed, b: r.n }), 2500);
  }, [showToast]);

  const viewerRef = useRef<Viewer | null>(null);
  viewerRef.current = viewer;
  const pendingBuild = useRef<BuildResult | null>(null);
  const gotState = useRef(false); // live state events win over the (possibly older) app:info snapshot

  useEffect(() => {
    if (viewer && pendingBuild.current) { const r = pendingBuild.current; pendingBuild.current = null; applyBuild(r, viewer, true); }
  }, [viewer, applyBuild]);

  // Subscriptions.
  useEffect(() => {
    api.info().then((i: any) => {
      setAppInfo(i);
      setScInfo(i.solidcraft);
      setSettings(i.settings);
      dispatch({ t: "kind", kind: i.settings.lastAgent ?? "claude" });
      if (i.project) {
        setInfo(i.project.info); setTree(i.project.tree);
        api.annotations.list().then(setAnnotations);
        api.params.list().then(setParams);
      }
      if (i.buildState && !gotState.current) setBuildState(i.buildState);
      if (i.build && !pendingBuild.current && !viewerRef.current) pendingBuild.current = i.build;
    });
    const offs = [
      api.project.onOpened((p: any) => {
        setInfo(p.info); setTree(p.tree); setHistory([]); setDiffs([]); setHidden(new Set()); setBuild(null); setActiveAnn(null);
        meshCache.current.clear();
        viewerRef.current?.clear();
      }),
      api.project.onInfo((i: ProjectInfo) => setInfo(i)),
      api.history.onState((h: HistoryState) => setUndoState(h)),
      api.annotations.onChanged((list: Annotation[]) => setAnnotations(list)),
      api.params.onChanged((list: Param[]) => setParams(list)),
      api.project.onChanged((c: any) => {
        setTree(c.tree);
        if (c.diffs?.length) setDiffs((d) => [...d, ...c.diffs].slice(-200));
        setFileVersion((n) => n + 1);
      }),
      api.cad.onState((s: BuildState) => { gotState.current = true; setBuildState(s); }),
      api.cad.onResult((r: BuildResult) => {
        const v = viewerRef.current;
        if (!v) { pendingBuild.current = r; return; }
        applyBuild(r, v, r.trigger === "opened");
      }),
      api.agent.onEvent((kind: AgentKind, ev: AgentEvent) => dispatch({ t: "ev", kind, ev })),
      api.agent.onMcpActivity((a: McpActivity) => {
        dispatch({ t: "act", a });
        if (a.tool === "render_view") showToast(tr("toast.agentLooks", { view: (a.args as any)?.view ?? "iso" }), 1800);
      }),
      api.viewer.onSnapshot(async (req: SnapshotRequest) => {
        const v = viewerRef.current;
        if (!v) return api.viewer.snapshotDone(req.reqId, null, "ingen vy");
        try { api.viewer.snapshotDone(req.reqId, await v.snapshot(req)); } catch (e: any) { api.viewer.snapshotDone(req.reqId, null, e?.message ?? String(e)); }
      }),
      api.viewer.onHighlight((h: { ids: string[]; message?: string }) => {
        viewerRef.current?.highlight(h.ids);
        if (h.message) showToast(tr("toast.agentSays", { msg: h.message }), 8000);
        window.setTimeout(() => viewerRef.current?.highlight([]), 9000);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [applyBuild, showToast]);

  useEffect(() => { viewer?.setHidden(hidden); }, [viewer, hidden]);

  const toggleScene = (path: string) => {
    if (!info) return;
    const scene = info.scene.includes(path) ? info.scene.filter((s) => s !== path) : [...info.scene, path];
    setInfo({ ...info, scene });
    api.project.setScene(scene);
  };

  const addAnnotation = async (sel: Selection) => {
    const part = build?.parts.find((x) => x.id === sel.partId);
    if (!part) return;
    let faceInfo: Record<string, unknown> | null = null;
    if (sel.face >= 0) { try { faceInfo = await api.cad.faceInfo(sel.partId, sel.face); } catch { faceInfo = null; } }
    const a = await api.annotations.add({
      partId: part.id, partName: part.name, source: part.source, face: sel.face,
      point: [sel.point.x, sel.point.y, sel.point.z], normal: sel.normal ? [sel.normal.x, sel.normal.y, sel.normal.z] : null,
      faceInfo, text: "",
    });
    if (a) setActiveAnn(a.id);
    viewer?.select(null);
  };

  const switchAgent = async (kind: AgentKind, resumeId?: string) => {
    if (agent.status === "busy" && !confirm(tr("confirm.switchAgent"))) return;
    dispatch({ t: "kind", kind });
    const r = await api.agent.start(kind, resumeId);
    if (!r.ok) dispatch({ t: "ev", kind, ev: { type: "error", message: r.error } });
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragOver(false); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const paths = [...e.dataTransfer.files].map((f) => api.project.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      // With a project folder open, dropped files are imported into it; otherwise the first one opens.
      if (info && tree && !info.singleFile) importFiles(undefined, paths);
      else api.project.open(paths[0]);
    },
  };

  if (!appInfo) return <div className="boot">{tr("app.starting")}</div>;

  if (!info || !tree) {
    return (
      <div className={`welcome ${dragOver ? "drag" : ""}`} {...dropProps}>
        <img className="welcome-mark" src="./icon-256.png" alt="" />
        <h1>SlashCAD</h1>
        <p className="muted">{tr("app.tagline")}</p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => api.project.openFileDialog()}>{tr("app.openFile")}</button>
          <button onClick={() => api.project.openDialog()}>{tr("app.openFolder")}</button>
          <button onClick={() => api.project.newDialog()}>{tr("app.newProject")}</button>
        </div>
        <p className="muted small">{tr("app.dropHint")}</p>
        <div>
        </div>
        {settings?.recentProjects?.length ? (
          <div className="recent">
            <h4>{tr("app.recent")}</h4>
            {settings.recentProjects.map((d) => <div key={d} className="recent-row" onClick={() => api.project.open(d)}>{d}</div>)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <LangContext.Provider value={settings?.language ?? "en"}>
    <div className={`app ${dragOver ? "drag" : ""}`} {...dropProps} style={{ gridTemplateColumns: `${leftW}px 4px 1fr 4px ${rightW}px` }}>
      <div className="topbar">
        <span className="brand"><img src="./icon-64.png" alt="" />SlashCAD</span>
        <span className="proj" title={info.dir}>{info.name}</span>
        {info.singleFile && <button className="primary" title={tr("app.makeProjectTitle")} onClick={() => api.project.makeProject()}>{tr("app.makeProject")}</button>}
        <span className="menu-wrap">
          <button onClick={() => setOpenMenu(!openMenu)}>{tr("app.open")} ▾</button>
          {openMenu && (
            <div className="menu open-menu" onMouseLeave={() => setOpenMenu(false)}>
              <div className="menu-item" onClick={() => { setOpenMenu(false); api.project.openFileDialog(); }}>{tr("app.openFile")}</div>
              <div className="menu-item" onClick={() => { setOpenMenu(false); api.project.openDialog(); }}>{tr("app.openFolder")}</div>
              <div className="menu-item" onClick={() => { setOpenMenu(false); api.project.newDialog(); }}>{tr("app.newProject")}</div>
            </div>
          )}
        </span>
        <span className="undo-btns">
          <button disabled={!undoState.undo} title={undoState.undo ? tr("app.undoTitle", { what: undoState.undo }) : tr("app.nothingUndo")} onClick={() => undo(false)}>↶</button>
          <button disabled={!undoState.redo} title={undoState.redo ? tr("app.redoTitle", { what: undoState.redo }) : tr("app.nothingRedo")} onClick={() => undo(true)}>↷</button>
        </span>
        <span className="grow" />
        <span className="menu-wrap">
          <button className={`sc-pill ${scInfo?.cli ? (scInfo.running ? "run" : "ok") : "off"}`} title={scInfo?.cli ? `${scInfo.version} · ${scInfo.cli}` : tr("sc.notFound")}
            onClick={async () => { setScInfo(await api.solidcraft.info()); setScMenu(!scMenu); }}>
            <span className="dot" />SolidCraft{scInfo?.cli && settings?.solidcraftEnabled !== false ? "" : " ✕"}
          </button>
          {scMenu && (
            <div className="menu sc-menu" onMouseLeave={() => setScMenu(false)}>
              {scInfo?.cli ? <>
                <div className="menu-title">{scInfo.version} · {scInfo.running ? tr("sc.running") : tr("sc.notRunning")}</div>
                {scInfo.app && <div className="menu-item" onClick={() => { setScMenu(false); api.solidcraft.open(); }}>{tr("sc.open")}</div>}
                <label className="menu-item check"><input type="checkbox" checked={settings?.solidcraftEnabled !== false}
                  onChange={(e) => api.setSettings({ solidcraftEnabled: e.target.checked }).then(setSettings)} /> {tr("sc.agentsUse")}</label>
                <div className="menu-note">{tr("sc.help")}</div>
              </> : <div className="menu-note">{tr("sc.install")}</div>}
            </div>
          )}
        </span>
        <button onClick={() => setShowSettings(true)}>{tr("app.settings")}</button>
      </div>
      <LeftPanel
        info={info} tree={tree} build={build} history={history} diffs={diffs} params={params} hidden={hidden} selectedPart={selection?.partId ?? null}
        onToggleScene={toggleScene}
        onOpenFile={(p) => setSource({ path: p, line: null })}
        onTogglePart={(id) => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onSelectPart={(id) => viewer?.selectPart(id)}
        onFitPart={(id) => viewer?.fit([id])}
        onShowAll={() => setHidden(new Set())}
        onImport={importFiles}
        onDelete={deleteFiles}
      />
      <div className="splitter" onPointerDown={leftDrag} />
      <div className="center">
        <ViewerPane
          viewer={viewer} mountRef={mountRef} build={build} buildState={buildState} info={info} settings={settings!}
          displayBackend={appInfo.displayBackend} selection={selection} toast={toast}
          onOpenSource={(path, line) => setSource({ path, line })}
          onAskAgent={(c) => setChip(c)}
          onAddAnnotation={addAnnotation}
          onTheme={(t) => api.setSettings({ theme: t }).then(setSettings)}
          onShowAll={() => setHidden(new Set())}
          onHide={(id) => setHidden((h) => new Set([...h, id]))}
          onIsolate={(id) => setHidden(new Set((build?.parts ?? []).map((p) => p.id).filter((x) => x !== id)))}
          onProjection={(p) => api.setSettings({ projection: p }).then(setSettings)}
        />
        {source && <SourceDrawer path={source.path} errorLine={source.line ?? build?.sources.find((s) => s.source === source.path)?.error?.line ?? null} version={fileVersion} onClose={() => setSource(null)} />}
      </div>
      <div className="splitter" onPointerDown={rightDrag} />
      <AgentPanel
        state={agent}
        binaries={{ claude: appInfo.claude, codex: appInfo.codex }}
        selectionChip={chip}
        onClearChip={() => setChip(null)}
        projectOpen={!!info}
        onSwitch={switchAgent}
        annotations={annotations}
        activeAnnotation={activeAnn}
        onActivateAnnotation={setActiveAnn}
        solidcraftOn={!!scInfo?.cli && settings?.solidcraftEnabled !== false}
      />
      {showSettings && settings && <SettingsDialog settings={settings} info={appInfo} onClose={() => setShowSettings(false)} onSaved={setSettings} />}
    </div>
    </LangContext.Provider>
  );
}
