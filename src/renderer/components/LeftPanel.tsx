import { useMemo, useState } from "react";
import type { BuildResult, FileDiff, FileNode, Param, PartInfo, ProjectInfo } from "../../shared/types";
import { api, fmtTime } from "../api";
import { ParamsPanel } from "./ParamsPanel";
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
}

function FileTree({ node, info, onToggle, onOpen, depth = 0 }: { node: FileNode; info: ProjectInfo; onToggle(p: string): void; onOpen(p: string): void; depth?: number }) {
  const t = useT();
  const [open, setOpen] = useState(depth < 2);
  if (node.dir) {
    return (
      <div>
        {depth > 0 && (
          <div className="tree-row dir" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => setOpen(!open)}>
            <span className="caret">{open ? "▾" : "▸"}</span>{node.name}
          </div>
        )}
        {open && node.children?.map((c) => <FileTree key={c.path} node={c} info={info} onToggle={onToggle} onOpen={onOpen} depth={depth + 1} />)}
      </div>
    );
  }
  const cad = isCad(node.path);
  const shown = info.scene.includes(node.path);
  return (
    <div className={`tree-row file ${shown ? "shown" : ""}`} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => onOpen(node.path)} title={node.path}>
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

export function LeftPanel(p: Props) {
  const t = useT();
  const [tab, setTab] = useState<"files" | "model" | "params" | "diffs" | "hist">("files");
  return (
    <div className="left-panel">
      <div className="tabs">
        <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>{t("left.files")}</button>
        <button className={tab === "model" ? "on" : ""} onClick={() => setTab("model")}>{t("left.model")}</button>
        <button className={tab === "params" ? "on" : ""} onClick={() => setTab("params")}>{t("left.params")}</button>
        <button className={tab === "diffs" ? "on" : ""} onClick={() => setTab("diffs")} >{t("left.diffs")}{p.diffs.length ? ` ${p.diffs.length}` : ""}</button>
        <button className={tab === "hist" ? "on" : ""} onClick={() => setTab("hist")}>{t("left.builds")}</button>
      </div>
      <div className="tab-body">
        {tab === "files" && <FileTree node={p.tree} info={p.info} onToggle={p.onToggleScene} onOpen={p.onOpenFile} />}
        {tab === "model" && <ModelTree {...p} />}
        {tab === "params" && <ParamsPanel params={p.params} />}
        {tab === "diffs" && <Diffs diffs={p.diffs} onOpen={p.onOpenFile} />}
        {tab === "hist" && <History history={p.history} />}
      </div>
    </div>
  );
}
