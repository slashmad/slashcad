import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildResult, DesignReport, FileDiff, FileNode, Param, PartInfo, ProjectInfo, Settings } from "../../shared/types";
import { api, fmtTime } from "../api";
import { ParamsPanel } from "./ParamsPanel";
import { ChecksPanel } from "./ChecksPanel";
import type { Viewer } from "../viewer/Viewer";
import { useT } from "../i18n";

const CAD = [".py", ".step", ".stp", ".brep", ".sc"];
const isCad = (p: string) => CAD.some((e) => p.toLowerCase().endsWith(e));

interface Props {
  info: ProjectInfo;
  tree: FileNode;
  build: BuildResult | null;
  history: BuildResult[];
  diffs: FileDiff[];
  params: Param[];
  hidden: Set<string>;
  selectedPart: string | null;
  onToggleScene(path: string): void;
  onOpenFile(path: string): void;
  onTogglePart(id: string): void;
  onSelectPart(id: string): void;
  onFitPart(id: string): void;
  onShowAll(): void;
  onImport(destDir?: string, paths?: string[]): void;
  onDelete(paths: string[]): void;
  viewer: Viewer | null;
  settings: Settings | null;
  onOpenSettings(): void;
}

interface TreeSel {
  selected: Set<string>;
  click(path: string, e: React.MouseEvent): void;
  menu(path: string, dir: boolean, e: React.MouseEvent): void;
  dropInto(dir: string, e: React.DragEvent): void;
}

/** File and folder paths in display order (folders first), for Shift-click ranges. */
function flatten(node: FileNode, out: string[] = []): string[] {
  for (const c of node.children ?? []) { out.push(c.path); if (c.dir) flatten(c, out); }
  return out;
}

function FileTree({ node, info, onToggle, onOpen, sel, depth = 0 }: { node: FileNode; info: ProjectInfo; onToggle(p: string): void; onOpen(p: string): void; sel: TreeSel; depth?: number }) {
  const t = useT();
  const [open, setOpen] = useState(depth < 2);
  const [dropHere, setDropHere] = useState(false);
  if (node.dir) {
    return (
      <div>
        {depth > 0 && (
          <div className={`tree-row dir ${sel.selected.has(node.path) ? "sel" : ""} ${dropHere ? "drop" : ""}`} style={{ paddingLeft: 6 + depth * 12 }}
            onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) sel.click(node.path, e); else setOpen(!open); }}
            onContextMenu={(e) => sel.menu(node.path, true, e)}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setDropHere(true); } }}
            onDragLeave={() => setDropHere(false)}
            onDrop={(e) => { setDropHere(false); sel.dropInto(node.path, e); }}>
            <span className="caret">{open ? "▾" : "▸"}</span>{node.name}
          </div>
        )}
        {open && node.children?.map((c) => <FileTree key={c.path} node={c} info={info} onToggle={onToggle} onOpen={onOpen} sel={sel} depth={depth + 1} />)}
      </div>
    );
  }
  const cad = isCad(node.path);
  const shown = info.scene.includes(node.path);
  return (
    <div className={`tree-row file ${shown ? "shown" : ""} ${sel.selected.has(node.path) ? "sel" : ""}`} style={{ paddingLeft: 6 + depth * 12 }}
      onClick={(e) => { sel.click(node.path, e); if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onOpen(node.path); }}
      onContextMenu={(e) => sel.menu(node.path, false, e)} title={node.path}>
      {cad ? (
        <button className={`eye ${shown ? "on" : ""}`} title={shown ? t("left.shownHide") : t("left.show")} onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}>{shown ? "◉" : "○"}</button>
      ) : <span className="eye-spacer" />}
      <span className={`fname ext-${node.name.split(".").pop()}`}>{node.name}</span>
      {node.size !== undefined && node.size > 1e6 && <span className="fsize">{(node.size / 1e6).toFixed(0)} MB</span>}
      {/\.(sc|step|stp)$/i.test(node.name) && <button className="tiny sc-open" title={t("left.openInSc")} onClick={(e) => { e.stopPropagation(); api.solidcraft.open(node.path); }}>↗</button>}
    </div>
  );
}

function ModelTree({ build, hidden, selectedPart, onTogglePart, onSelectPart, onFitPart, onShowAll }: Pick<Props, "build" | "hidden" | "selectedPart" | "onTogglePart" | "onSelectPart" | "onFitPart" | "onShowAll">) {
  const groups = useMemo(() => {
    const m = new Map<string, PartInfo[]>();
    for (const p of build?.parts ?? []) m.set(p.source, [...(m.get(p.source) ?? []), p]);
    return [...m.entries()];
  }, [build]);
  const t = useT();
  const [filter, setFilter] = useState("");
  if (!build) return <div className="muted pad">{t("left.noBuild")}</div>;
  const f = filter.toLowerCase();
  return (
    <div className="model-tree">
      <div className="mt-tools">
        <input placeholder={t("left.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {hidden.size > 0 && <button onClick={onShowAll}>{t("left.showAll", { n: hidden.size })}</button>}
      </div>
      {groups.map(([src, parts]) => (
        <div key={src} className="mt-group">
          <div className="mt-src">{src} <span className="muted">({parts.length})</span></div>
          {parts.filter((p) => !f || p.name.toLowerCase().includes(f)).slice(0, 2000).map((p) => (
            <div key={p.id} className={`tree-row part ${selectedPart === p.id ? "sel" : ""} ${hidden.has(p.id) ? "hid" : ""}`}
              onClick={() => onSelectPart(p.id)} onDoubleClick={() => onFitPart(p.id)} title={p.id}>
              <button className={`eye ${hidden.has(p.id) ? "" : "on"}`} onClick={(e) => { e.stopPropagation(); onTogglePart(p.id); }}>{hidden.has(p.id) ? "○" : "◉"}</button>
              <span className="swatch" style={{ background: p.color ? `rgb(${p.color.slice(0, 3).map((c) => Math.round(Math.pow(c, 1 / 2.2) * 255)).join(",")})` : "#9aa4b2" }} />
              <span className="fname">{p.name}</span>
              {p.changed && <span className="badge new">{t("left.changed")}</span>}
              {p.stale && <span className="badge stale">{t("left.stale")}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Diffs({ diffs, onOpen }: { diffs: FileDiff[]; onOpen(p: string): void }) {
  const t = useT();
  if (!diffs.length) return <div className="muted pad">{t("left.noDiffs")}</div>;
  return (
    <div className="diffs">
      {[...diffs].reverse().map((d, i) => {
        const add = d.hunks.filter((h) => h.type === "add").reduce((n, h) => n + h.lines.length, 0);
        const del = d.hunks.filter((h) => h.type === "del").reduce((n, h) => n + h.lines.length, 0);
        return (
          <details key={`${d.path}-${d.ts}-${i}`} open={i < 2} className="diff">
            <summary><span className="fname" onClick={(e) => { e.preventDefault(); onOpen(d.path); }}>{d.path}</span> <span className="add">+{add}</span> <span className="del">−{del}</span> <span className="muted small">{fmtTime(d.ts)}</span></summary>
            <pre className="diff-body">
              {d.hunks.map((h, j) => h.lines.map((l, k) => (
                <div key={`${j}-${k}`} className={`dl ${h.type}`}><span className="ln">{h.type === "add" ? h.newStart + k : h.oldStart + k}</span>{h.type === "add" ? "+" : h.type === "del" ? "−" : " "} {l}</div>
              )))}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function History({ history }: { history: BuildResult[] }) {
  const t = useT();
  if (!history.length) return <div className="muted pad">{t("left.noBuilds")}</div>;
  return (
    <div className="history">
      {[...history].reverse().map((b) => {
        const errs = b.sources.filter((s) => s.error).length;
        const changed = b.parts.filter((p) => p.changed).length;
        return (
          <div key={b.n} className={`hist-row ${errs ? "bad" : ""}`}>
            <span className="hn">#{b.n}</span>
            <span className="ht">{fmtTime(b.startedAt)}</span>
            <span className="hw">{t(`trigger.${b.trigger}`)}</span>
            <span className="hs">{b.seconds.toFixed(2)} s</span>
            <span className="hc">{errs ? t("left.errors", { n: errs }) : t("left.changedOf", { c: changed, n: b.parts.length })}</span>
          </div>
        );
      })}
    </div>
  );
}

function Files(p: Props) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const anchor = useRef<string | null>(null);
  const order = useMemo(() => flatten(p.tree), [p.tree]);
  // Forget selected paths that no longer exist (deleted, renamed).
  const live = useMemo(() => new Set(order), [order]);
  const sel = useMemo(() => [...selected].filter((x) => live.has(x)), [selected, live]);
  const single = !!p.info.singleFile;
  const treeSel: TreeSel = {
    selected: new Set(sel),
    click(path, e) {
      if (e.shiftKey && anchor.current) {
        const a = order.indexOf(anchor.current), b = order.indexOf(path);
        if (a >= 0 && b >= 0) { setSelected(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1))); return; }
      }
      if (e.ctrlKey || e.metaKey) {
        setSelected((cur) => { const n = new Set(cur); n.has(path) ? n.delete(path) : n.add(path); return n; });
      } else setSelected(new Set([path]));
      anchor.current = path;
    },
    menu(path, dir, e) {
      e.preventDefault();
      if (!selected.has(path)) { setSelected(new Set([path])); anchor.current = path; }
      setMenu({ x: e.clientX, y: e.clientY, path, dir });
    },
    dropInto(dir, e) {
      e.preventDefault(); e.stopPropagation();
      const paths = [...e.dataTransfer.files].map((f) => api.project.pathForFile(f)).filter(Boolean);
      if (paths.length) p.onImport(dir, paths);
    },
  };
  const del = (paths: string[]) => { if (paths.length) p.onDelete(paths); };
  return (
    <div className="files" tabIndex={0} onKeyDown={(e) => {
      if ((e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) && sel.length && !single) { e.preventDefault(); del(sel); }
      else if (e.key === "Escape") setSelected(new Set());
    }}>
      {!single && (
        <div className="files-tools">
          <button title={t("left.importTitle")} onClick={() => p.onImport()}>{t("left.import")}</button>
          <button disabled={!sel.length} title={t("left.deleteTitle")} onClick={() => del(sel)}>{sel.length > 1 ? t("left.deleteN", { n: sel.length }) : t("left.delete")}</button>
          <span className="grow" />
          <span className="muted small" title={t("left.selectHint")}>ⓘ</span>
        </div>
      )}
      <FileTree node={p.tree} info={p.info} onToggle={p.onToggleScene} onOpen={p.onOpenFile} sel={treeSel} />
      {menu && (
        <div className="ctx-back" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="menu ctx" style={{ left: menu.x, top: menu.y, position: "fixed" }} onPointerDown={(e) => e.stopPropagation()}>
            {menu.dir && !single && <div className="menu-item" onClick={() => { setMenu(null); p.onImport(menu.path); }}>{t("left.importHere")}</div>}
            <div className="menu-item" onClick={() => { setMenu(null); api.project.reveal(menu.path); }}>{t("left.reveal")}</div>
            {!single && <>
              <div className="menu-sep" />
              <div className="menu-item danger" onClick={() => { setMenu(null); del(sel.length ? sel : [menu.path]); }}>{sel.length > 1 ? t("left.deleteN", { n: sel.length }) : t("left.delete")}</div>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

export function LeftPanel(p: Props) {
  const t = useT();
  const [tab, setTab] = useState<"files" | "model" | "params" | "checks" | "diffs" | "hist">("files");
  const [report, setReport] = useState<DesignReport | null>(null);
  useEffect(() => { api.checks.report().then(setReport); const off = api.checks.onReport(setReport); return () => { off(); }; }, []);
  const fails = report?.summary.fail ?? 0;
  return (
    <div className="left-panel">
      <div className="tabs">
        <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>{t("left.files")}</button>
        <button className={tab === "model" ? "on" : ""} onClick={() => setTab("model")}>{t("left.model")}</button>
        <button className={tab === "params" ? "on" : ""} onClick={() => setTab("params")}>{t("left.params")}</button>
        <button className={`${tab === "checks" ? "on" : ""} ${fails ? "bad" : ""}`} title={fails ? t("chk.tabFails", { n: fails }) : undefined} onClick={() => setTab("checks")}>{t("left.checks")}{fails ? ` ${fails}` : ""}</button>
        <button className={tab === "diffs" ? "on" : ""} onClick={() => setTab("diffs")} >{t("left.diffs")}{p.diffs.length ? ` ${p.diffs.length}` : ""}</button>
        <button className={tab === "hist" ? "on" : ""} onClick={() => setTab("hist")}>{t("left.builds")}</button>
      </div>
      <div className="tab-body">
        {tab === "files" && <Files {...p} />}
        {tab === "model" && <ModelTree {...p} />}
        {tab === "params" && <ParamsPanel params={p.params} />}
        {tab === "checks" && <ChecksPanel build={p.build} params={p.params} selectedPart={p.selectedPart} viewer={p.viewer} settings={p.settings} onOpenSettings={p.onOpenSettings} />}
        {tab === "diffs" && <Diffs diffs={p.diffs} onOpen={p.onOpenFile} />}
        {tab === "hist" && <History history={p.history} />}
      </div>
    </div>
  );
}
