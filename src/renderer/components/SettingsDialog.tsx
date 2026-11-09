import { useState } from "react";
import type { Settings } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";
import { DEFAULT_NAV, mappingTable } from "../viewer/navigation";

type Page = "general" | "navigation" | "agents";

const NAV_DEFAULTS: Partial<Settings> = {
  navigation: DEFAULT_NAV.mapping, rightDragOrbits: true, orbitStyle: "turntable", orbitAround: "view-center", middleDoubleClick: "home",
  zoomToCursor: true, reverseZoom: false, zoomSpeed: 1, smoothZoom: true, twoFingerPan: true, animateViews: true, animationSpeed: 1, fitSize: 1,
  fitOnViewChange: false, projection: "perspective",
};

function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="choice">
      {options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function SettingsDialog({ settings, info, onClose, onSaved }: { settings: Settings; info: any; onClose(): void; onSaved(s: Settings): void }) {
  const t = useT();
  const [s, setS] = useState<Settings>(settings);
  const [page, setPage] = useState<Page>("navigation");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v === "" ? undefined : v });
  const save = async () => { onSaved(await api.setSettings(s)); onClose(); };
  const cfg = {
    mapping: s.navigation, rightDragOrbits: s.rightDragOrbits, orbitStyle: s.orbitStyle, orbitAround: s.orbitAround, zoomToCursor: s.zoomToCursor,
    reverseZoom: s.reverseZoom, zoomSpeed: s.zoomSpeed, smoothZoom: s.smoothZoom, twoFingerPan: s.twoFingerPan,
  };
  const check = (k: keyof Settings, label: string) => (
    <label className="check"><input type="checkbox" checked={!!s[k]} onChange={(e) => set(k, e.target.checked as any)} /> {label}</label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <h3>{t("set.title")}</h3>
          {(["general", "navigation", "agents"] as Page[]).map((p) => (
            <button key={p} className={page === p ? "on" : ""} onClick={() => setPage(p)}>{t(`set.${p}`)}</button>
          ))}
        </div>
        <div className="settings-body">
          {page === "general" && (
            <>
              <h4>{t("set.general")}</h4>
              <div className="row"><span>{t("set.language")}</span><Choice value={s.language ?? "en"} options={[["en", "English"], ["sv", "Svenska"]]} onChange={(v) => set("language", v)} /></div>
              <div className="row"><span>{t("set.theme")}</span><Choice value={s.theme} options={[["dark", t("set.dark")], ["light", t("set.light")]]} onChange={(v) => set("theme", v)} /></div>
              {info.platform === "linux" && (
                <div className="row"><span>{t("set.display")} – {info.displayBackend}</span>
                  <Choice value={s.displayBackend} options={[["auto", t("set.auto")], ["wayland", "Wayland"], ["x11", "X11"]]} onChange={(v) => set("displayBackend", v)} />
                </div>
              )}
              <label>{t("set.python")} <input placeholder={t("set.auto")} value={s.pythonPath ?? ""} onChange={(e) => set("pythonPath", e.target.value)} /></label>
              <label>{t("set.timeout")} <input type="number" min={30} value={s.buildTimeoutSec} onChange={(e) => set("buildTimeoutSec", Number(e.target.value))} /></label>
            </>
          )}

          {page === "navigation" && (
            <>
              <h4>{t("set.mouse")}</h4>
              <div className="row"><span>{t("set.mapping")}</span>
                <select value={s.navigation} onChange={(e) => set("navigation", e.target.value as Settings["navigation"])}>
                  <option value="fusion">Fusion 360</option>
                  <option value="solidworks">SolidWorks</option>
                  <option value="onshape">Onshape</option>
                </select>
              </div>
              <table className="map-table"><tbody>
                {mappingTable(cfg).map(([keys, action], i) => (
                  <tr key={i}><td>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</td><td>{t(`nav.${action}`)}</td></tr>
                ))}
              </tbody></table>
              {check("rightDragOrbits", t("set.rightDragOrbits"))}
              <div className="row"><span>{t("set.middleDouble")}</span>
                <Choice value={s.middleDoubleClick} options={[["home", t("set.home")], ["fit", t("set.fit")], ["none", t("set.none")]]} onChange={(v) => set("middleDoubleClick", v)} />
              </div>

              <h4>{t("set.orbitAround")}</h4>
              <Choice value={s.orbitAround} options={[["origin", t("set.origin")], ["view-center", t("set.viewCenter")], ["cursor", t("set.underCursor")]]} onChange={(v) => set("orbitAround", v)} />
              <div className="row"><span>{t("set.orbitStyle")}</span>
                <Choice value={s.orbitStyle} options={[["turntable", t("set.turntable")], ["free", t("set.free")]]} onChange={(v) => set("orbitStyle", v)} />
              </div>

              <h4>{t("set.wheel")}</h4>
              <div className="grid2">
                {check("zoomToCursor", t("set.zoomToCursor"))}
                {check("smoothZoom", t("set.smoothZoom"))}
                {check("reverseZoom", t("set.reverseZoom"))}
                {check("twoFingerPan", t("set.twoFingerPan"))}
              </div>
              <div className="row"><span>{t("set.zoomSpeed")}</span>
                <input type="range" min={0.25} max={3} step={0.05} value={s.zoomSpeed} onChange={(e) => set("zoomSpeed", Number(e.target.value))} /><code>{s.zoomSpeed.toFixed(2)}×</code>
              </div>

              <h4>{t("set.view")}</h4>
              <div className="row"><span>{t("set.projection")}</span>
                <Choice value={s.projection} options={[["perspective", t("set.perspective")], ["orthographic", t("set.orthographic")]]} onChange={(v) => set("projection", v)} />
              </div>
              {check("ambientOcclusion", t("set.ao"))}
              {check("animateViews", t("set.animate"))}
              <div className="row"><span>{t("set.animSpeed")}</span>
                <input type="range" min={0.25} max={3} step={0.05} value={s.animationSpeed} onChange={(e) => set("animationSpeed", Number(e.target.value))} /><code>{s.animationSpeed.toFixed(2)}×</code>
              </div>
              <div className="row"><span>{t("set.fitSize")}</span>
                <input type="range" min={0.5} max={1} step={0.01} value={s.fitSize} onChange={(e) => set("fitSize", Number(e.target.value))} /><code>{Math.round(s.fitSize * 100)} %</code>
              </div>
              {check("fitOnViewChange", t("set.fitOnViewChange"))}
              <button className="link" onClick={() => setS({ ...s, ...NAV_DEFAULTS } as Settings)}>{t("set.restoreDefaults")}</button>
            </>
          )}

          {page === "agents" && (
            <>
              <h4>Claude Code</h4>
              <label>{t("set.binary")} <span className="muted small">{t("set.foundBinary")}: {info.claude?.version ?? t("set.none.found")}</span>
                <input placeholder={info.claude?.path ?? "claude"} value={s.claudePath ?? ""} onChange={(e) => set("claudePath", e.target.value)} />
              </label>
              <label>{t("set.model")} <input placeholder="default (opus, sonnet, haiku …)" value={s.claudeModel ?? ""} onChange={(e) => set("claudeModel", e.target.value)} /></label>
              <h4>ChatGPT (Codex)</h4>
              <label>{t("set.binary")} <span className="muted small">{t("set.foundBinary")}: {info.codex?.version ?? t("set.none.found")}</span>
                <input placeholder={info.codex?.path ?? "codex"} value={s.codexPath ?? ""} onChange={(e) => set("codexPath", e.target.value)} />
              </label>
              <label>{t("set.model")} <input placeholder="default from ~/.codex/config.toml" value={s.codexModel ?? ""} onChange={(e) => set("codexModel", e.target.value)} /></label>
              <div className="modal-row">
                <button onClick={async () => { await api.project.installMcp(); alert(t("set.vscodeDone")); }}>{t("set.vscode")}</button>
              </div>
            </>
          )}
          <div className="modal-actions">
            <button onClick={onClose}>{t("set.cancel")}</button>
            <button className="primary" onClick={save}>{t("set.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
