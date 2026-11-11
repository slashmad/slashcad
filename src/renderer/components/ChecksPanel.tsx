// Checks tab: design rules (slashcad.rules.json), motion study (pose sweep with preview),
// printability (overhang map, orientations, analysis slicing) and the physical test log
// (slashcad.tests.json). Physical results are the primary evidence; the other three are
// nominal geometry checks and say so.
import { useEffect, useMemo, useState } from "react";
import type { BuildResult, DesignFile, DesignReport, DesignRule, Param, PrintReport, RuleKind, Settings, SweepResult, TestEntry } from "../../shared/types";
import { describeRule } from "../../shared/ruleText";
import { api } from "../api";
import { useT } from "../i18n";
import type { Viewer } from "../viewer/Viewer";

type Sub = "rules" | "motion" | "print" | "tests";

interface Props {
  build: BuildResult | null;
  params: Param[];
  selectedPart: string | null;
  viewer: Viewer | null;
  settings: Settings | null;
  onOpenSettings(): void;
}

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const mark = (s: string) => (s === "fail" ? "✕" : s === "warn" ? "!" : s === "incomplete" ? "?" : "✓");

export function ChecksPanel(p: Props) {
  const t = useT();
  const [sub, setSub] = useState<Sub>(() => { try { return (localStorage.getItem("checks-sub") as Sub) || "rules"; } catch { return "rules"; } });
  const [report, setReport] = useState<DesignReport | null>(null);
  const [design, setDesign] = useState<DesignFile | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [prints, setPrints] = useState<PrintReport[]>([]);
  const [tests, setTests] = useState<TestEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.checks.report().then(setReport);
    api.checks.sweep().then(setSweep);
    api.checks.prints().then(setPrints);
    api.design.get().then(setDesign);
    api.tests.list().then(setTests);
    const offs = [
      api.checks.onReport(setReport), api.checks.onSweep(setSweep), api.checks.onPrints(setPrints),
      api.checks.onRunning(setRunning), api.design.onChanged(setDesign), api.tests.onChanged(setTests),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const go = (s: Sub) => { setSub(s); setError(null); try { localStorage.setItem("checks-sub", s); } catch { /* storage unavailable */ } };
  const act = async (f: () => Promise<unknown>) => { setError(null); try { await f(); } catch (e) { setError(errText(e)); } };
  const show = (ids?: string[]) => { if (ids?.length) { p.viewer?.highlight(ids); window.setTimeout(() => p.viewer?.highlight([]), 6000); } };

  return (
    <div className="checks">
      <div className="subtabs">
        {(["rules", "motion", "print", "tests"] as Sub[]).map((s) => (
          <button key={s} className={sub === s ? "on" : ""} onClick={() => go(s)}>
            {t(`chk.${s}`)}
            {s === "rules" && report?.summary.fail ? <span className="badge bad">{report.summary.fail}</span> : null}
            {s === "tests" && tests.length ? <span className="badge">{tests.length}</span> : null}
          </button>
        ))}
      </div>
      {running && <div className="muted small pad-x">{t("chk.running", { what: t(`chk.run.${running}`) })}</div>}
      {error && <div className="chk-error">{error}</div>}
      {sub === "rules" && <Rules {...p} report={report} design={design} act={act} show={show} busy={!!running} />}
      {sub === "motion" && <Motion {...p} sweep={sweep} design={design} act={act} show={show} busy={!!running} />}
      {sub === "print" && <Print {...p} prints={prints} act={act} show={show} busy={!!running} />}
      {sub === "tests" && <Tests {...p} tests={tests} act={act} />}
    </div>
  );
}

type Ctx = { act(f: () => Promise<unknown>): Promise<void>; show(ids?: string[]): void; busy?: boolean };

// ---------------------------------------------------------------- rules

const KINDS: RuleKind[] = ["clearance", "allow_contact", "retained", "path_clear", "envelope"];
const DIRS: [string, [number, number, number]][] = [["+Z", [0, 0, 1]], ["−Z", [0, 0, -1]], ["+X", [1, 0, 0]], ["−X", [-1, 0, 0]], ["+Y", [0, 1, 0]], ["−Y", [0, -1, 0]]];

function Rules(p: Props & Ctx & { report: DesignReport | null; design: DesignFile | null }) {
  const t = useT();
  const r = p.report;
  const names = useMemo(() => [...new Set((p.build?.parts ?? []).map((x) => x.name))].sort(), [p.build]);
  const [form, setForm] = useState<any>(null);
  const sel = p.selectedPart ? p.build?.parts.find((x) => x.id === p.selectedPart) : null;
  const inter = (r?.pairs ?? []).filter((x) => x.kind === "interference" && !x.allowed_by);
  const close = (r?.pairs ?? []).filter((x) => x.kind !== "interference").slice(0, 12);
  const rules = p.design?.rules ?? [];

  const startForm = (kind: RuleKind) => setForm({ kind, a: sel?.name ?? "", b: "", min: 0.2, part: sel?.name ?? "", against: "*", dir: "+Z", within: 1, distance: 10, max: ["", "", ""], note: "" });
  const save = () => p.act(async () => {
    const f = form;
    const rule: Partial<DesignRule> = { kind: f.kind, note: f.note || undefined };
    if (f.kind === "clearance" || f.kind === "allow_contact") Object.assign(rule, { a: f.a, b: f.b }, f.kind === "clearance" ? { min: Number(f.min) } : {});
    if (f.kind === "retained") Object.assign(rule, { part: f.part, against: f.against || "*", directions: [DIRS.find((d) => d[0] === f.dir)![1]], within: Number(f.within) });
    if (f.kind === "path_clear") Object.assign(rule, { part: f.part, against: f.against || "*", direction: DIRS.find((d) => d[0] === f.dir)![1], distance: Number(f.distance) });
    if (f.kind === "envelope") Object.assign(rule, { parts: f.a || "*", max: f.max.map((v: string) => (v === "" ? null : Number(v))) });
    await api.design.addRule(rule);
    setForm(null);
  });
  const field = (k: string, label: string, list = true, type = "text") => (
    <label className="chk-field">{label}<input type={type} value={form[k]} list={list ? "chk-parts" : undefined} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
  );

  return (
    <div className="chk-body">
      <div className="chk-head">
        <span className={`chk-sum ${r?.summary.fail ? "bad" : r?.summary.warn || r?.complete === false ? "warn" : r ? "ok" : ""}`}>
          {!r ? t("chk.notRun") : r.error ? t("chk.failedRun") : r.skipped ? r.skipped : t("chk.summary", { f: r.summary.fail, w: r.summary.warn, p: r.summary.pass, b: r.build })}
          {r?.complete === false ? ` · ${t("chk.incompleteRun")}` : ""}
        </span>
        <button disabled={p.busy || !p.build} onClick={() => p.act(() => api.checks.run())}>{t("chk.runChecks")}</button>
      </div>
      {r?.error && <div className="chk-error">{r.error}</div>}
      {(r?.results ?? []).map((x) => (
        <div key={x.id} className={`chk-row ${x.status}`} onClick={() => p.show(x.parts)} title={t("chk.clickShow")}>
          <span className="chk-mark">{mark(x.status)}</span>
          <span className="chk-text"><b>{x.id}</b> {x.detail}</span>
        </div>
      ))}
      {inter.length > 0 && <div className="chk-sub">{t("chk.interfering")}</div>}
      {inter.slice(0, 20).map((x, i) => (
        <div key={i} className="chk-row fail small" onClick={() => p.show([x.a, x.b])}>{x.a_name} ↔ {x.b_name}: {x.overlap_mm3 ?? "?"} mm³</div>
      ))}
      {close.length > 0 && <div className="chk-sub">{t("chk.closest")}</div>}
      {close.map((x, i) => (
        <div key={i} className="chk-row small" onClick={() => p.show([x.a, x.b])}>
          {x.a_name} ↔ {x.b_name}: {x.kind === "touch" ? t("chk.touching") : `${x.distance_mm} mm`}{x.allowed_by ? ` · ${x.allowed_by}` : ""}
        </div>
      ))}
      {r && !r.error && !r.skipped && <div className="muted small pad-x">{t("chk.nominalNote")}</div>}

      <div className="chk-sub">{t("chk.rulesTitle", { n: rules.length })}</div>
      {p.design?.error && <div className="chk-error">{p.design.error}</div>}
      {!rules.length && <div className="muted small pad-x">{t("chk.noRules")}</div>}
      {rules.map((x) => (
        <div key={x.id} className="chk-rule">
          <span className="chk-text"><b>{x.id}</b> {describeRule(x)}{x.note ? <span className="muted"> – {x.note}</span> : null}{x.by && x.by !== "user" ? <span className="muted"> ({x.by})</span> : null}</span>
          <button className="tiny" title={t("chk.removeRule")} onClick={() => p.act(() => api.design.removeRule(x.id))}>×</button>
        </div>
      ))}
      <datalist id="chk-parts">{["*", ...names].map((n) => <option key={n} value={n} />)}</datalist>
      {!form ? (
        <div className="chk-actions">
          <select value="" onChange={(e) => e.target.value && startForm(e.target.value as RuleKind)}>
            <option value="">{t("chk.addRule")}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`chk.kind.${k}`)}</option>)}
          </select>
          <button disabled={!sel} title={t("chk.protectTitle")} onClick={() => sel && p.act(() => api.design.protect([sel.id], `${sel.name} must not change`))}>{t("chk.protect")}</button>
        </div>
      ) : (
        <div className="chk-form">
          <div className="muted small">{t(`chk.help.${form.kind}`)}</div>
          {(form.kind === "clearance" || form.kind === "allow_contact") && <>{field("a", t("chk.f.a"))}{field("b", t("chk.f.b"))}</>}
          {form.kind === "clearance" && field("min", t("chk.f.min"), false, "number")}
          {(form.kind === "retained" || form.kind === "path_clear") && <>
            {field("part", t("chk.f.part"))}{field("against", t("chk.f.against"))}
            <label className="chk-field">{t("chk.f.dir")}<select value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}>{DIRS.map(([k]) => <option key={k}>{k}</option>)}</select></label>
            {form.kind === "retained" ? field("within", t("chk.f.within"), false, "number") : field("distance", t("chk.f.distance"), false, "number")}
          </>}
          {form.kind === "envelope" && <>
            {field("a", t("chk.f.parts"))}
            <div className="chk-field">{t("chk.f.max")}<span className="xyz">{[0, 1, 2].map((i) => (
              <input key={i} type="number" placeholder={"XYZ"[i]} value={form.max[i]} onChange={(e) => { const m = [...form.max]; m[i] = e.target.value; setForm({ ...form, max: m }); }} />
            ))}</span></div>
          </>}
          {field("note", t("chk.f.note"), false)}
          <div className="chk-actions"><button onClick={() => setForm(null)}>{t("set.cancel")}</button><button className="primary" onClick={save}>{t("chk.save")}</button></div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- motion

function Motion(p: Props & Ctx & { sweep: SweepResult | null; design: DesignFile | null }) {
  const t = useT();
  const numeric = p.params;
  const def = p.design?.sweep;
  const [param, setParam] = useState(def?.param ?? numeric[0]?.name ?? "");
  const cur = numeric.find((x) => x.name === param);
  const [from, setFrom] = useState(def?.from ?? 0);
  const [to, setTo] = useState(def?.to ?? (cur ? Math.max(cur.value, 10) : 10));
  const [step, setStep] = useState(def?.step ?? 1);
  const [useRules, setUseRules] = useState(true);
  const [pose, setPose] = useState<number | null>(p.build?.preview?.param === param ? p.build.preview.value : null);
  useEffect(() => { if (def) { setParam(def.param); setFrom(def.from); setTo(def.to); setStep(def.step); } }, [def?.param, def?.from, def?.to, def?.step]);
  useEffect(() => { setPose(p.build?.preview ? p.build.preview.value : null); }, [p.build?.preview?.value, p.build?.preview?.param]);

  const preview = (v: number | null) => p.act(async () => {
    if (v === null || !cur) { await api.checks.preview(null); return; }
    await api.checks.preview({ file: cur.file, param, value: v });
  });
  const s = p.sweep;
  if (!numeric.length) return <div className="muted pad">{t("chk.motionNone")}</div>;
  return (
    <div className="chk-body">
      <div className="muted small pad-x">{t("chk.motionHelp")}</div>
      <div className="chk-form">
        <label className="chk-field">{t("chk.param")}<select value={param} onChange={(e) => setParam(e.target.value)}>{numeric.map((x) => <option key={`${x.file}:${x.name}`} value={x.name}>{x.name} ({x.value})</option>)}</select></label>
        <div className="chk-field">{t("chk.range")}<span className="xyz">
          <input type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} title={t("chk.from")} />
          <input type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} title={t("chk.to")} />
          <input type="number" value={step} min={0} onChange={(e) => setStep(Number(e.target.value))} title={t("chk.step")} />
        </span></div>
        <label className="check"><input type="checkbox" checked={useRules} onChange={(e) => setUseRules(e.target.checked)} /> {t("chk.useRules")}</label>
        <div className="chk-actions">
          <button className="primary" disabled={p.busy || !param} onClick={() => p.act(() => api.checks.runSweep({ param, from, to, step, file: cur?.file, useRules }))}>{t("chk.runSweep")}</button>
          <button title={t("chk.saveSweepTitle")} onClick={() => p.act(() => api.design.setSweep({ param, from, to, step, file: cur?.file }))}>{t("chk.saveSweep")}</button>
        </div>
        <div className="chk-field">{t("chk.preview")}
          <span className="xyz">
            <input type="range" min={Math.min(from, to)} max={Math.max(from, to)} step={step || 1} value={pose ?? cur?.value ?? from}
              onChange={(e) => setPose(Number(e.target.value))} onPointerUp={() => pose !== null && preview(pose)} onKeyUp={() => pose !== null && preview(pose)} />
            <code>{pose ?? "–"}</code>
            <button className="tiny" disabled={!p.build?.preview} onClick={() => preview(null)}>{t("chk.backToFile")}</button>
          </span>
        </div>
      </div>
      {s && (
        <>
          <div className={`chk-sum pad-x ${s.failing_poses.length ? "bad" : "ok"}`}>
            {t("chk.sweepSummary", { n: s.poses_checked, total: s.values.length, p: s.param, s: s.seconds })}
            {!s.complete ? ` ${t("chk.incomplete")}` : ""}
          </div>
          <div className="muted small pad-x">{t("chk.sampledNote")}</div>
          {s.failing_poses.length > 0 && <div className="chk-sub">{t("chk.failingPoses")}</div>}
          {s.poses.filter((x) => x.interferences || x.rule_failures.length || x.errors.length).slice(0, 40).map((x) => (
            <div key={x.value} className="chk-row fail small" onClick={() => { preview(x.value); p.show(x.worst ? [x.worst.a, x.worst.b] : undefined); }} title={t("chk.clickPose")}>
              {s.param} = {x.value}: {x.interferences ? `${x.interferences} × ${x.worst ? `${x.worst.a_name} ↔ ${x.worst.b_name}` : ""}` : ""}
              {x.rule_failures.map((f) => ` ${f.id}`).join(",")}{x.errors.length ? ` ${x.errors[0]}` : ""}
            </div>
          ))}
          <div className="chk-sub">{t("chk.closestSweep")}</div>
          {s.closest_pairs.slice(0, 20).map((c, i) => (
            <div key={i} className={`chk-row small ${c.kind === "interference" && !c.allowed_by ? "fail" : ""}`} onClick={() => { preview(c.at); p.show([c.a, c.b]); }} title={t("chk.clickPose")}>
              {c.a_name} ↔ {c.b_name}: {c.kind === "interference" ? `${c.max_overlap_mm3} mm³` : c.kind === "touch" ? t("chk.touching") : `${c.min_distance_mm} mm`} @ {c.at}{c.allowed_by ? ` · ${c.allowed_by}` : ""}
            </div>
          ))}
          {!s.closest_pairs.length && <div className="muted small pad-x">{t("chk.noneClose", { mm: s.near_mm })}</div>}
          <div className="muted small pad-x">{t("chk.nominalNote")}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- printability

function Print(p: Props & Ctx & { prints: PrintReport[] }) {
  const t = useT();
  const s = p.settings;
  const [slicer, setSlicer] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(p.viewer?.overhangDeg != null);
  useEffect(() => { api.checks.slicer().then(setSlicer); }, []);
  useEffect(() => { if (overlay && s) p.viewer?.setOverhang(s.overhangDeg); }, [s?.overhangDeg]);
  const toggle = (on: boolean) => { setOverlay(on); p.viewer?.setOverhang(on ? s?.overhangDeg ?? 45 : null); };
  const sel = p.selectedPart;
  const live = new Set((p.build?.parts ?? []).map((x) => x.id));
  const list = p.prints.filter((x) => live.has(x.id));
  return (
    <div className="chk-body">
      <div className="muted small pad-x">
        {t("chk.printer", { bed: s?.printerBed.join(" × ") ?? "?", n: s?.printerNozzle ?? "?", deg: s?.overhangDeg ?? 45, fit: s?.fitClearance ?? "?" })}{" "}
        <button className="link" onClick={p.onOpenSettings}>{t("chk.printerEdit")}</button>
      </div>
      <label className="check pad-x"><input type="checkbox" checked={overlay} onChange={(e) => toggle(e.target.checked)} /> {t("chk.showOverhang")}</label>
      <div className="chk-actions pad-x">
        <button disabled={p.busy || !sel} onClick={() => sel && p.act(() => api.checks.printability([sel]))}>{t("chk.checkSelected")}</button>
        <button disabled={p.busy || !p.build?.parts.length} onClick={() => p.act(() => api.checks.printability())}>{t("chk.checkAll")}</button>
      </div>
      <div className="muted small pad-x">{t("chk.printHelp")}</div>
      {list.map((r) => (
        <div key={r.id} className={`chk-card ${r.error || r.fits_bed === false || (r.overhang_mm2 ?? 0) > 1 ? "warn" : "ok"}`} onClick={() => p.show([r.id])}>
          <div className="chk-card-title">{r.name}</div>
          {r.error ? <div className="chk-error">{r.error}</div> : <>
            <div className="small">{r.size_mm?.join(" × ")} mm · {r.fits_bed ? t("chk.fits") : t("chk.noFit")}</div>
            <div className="small">{t("chk.overhang", { a: r.overhang_mm2 ?? 0, f: r.flat_down_mm2 ?? 0, b: r.bed_contact_mm2 ?? 0 })}</div>
            <div className="small">{t("chk.best", { o: r.best_orientation ?? "?" })}</div>
            {(r.hints ?? []).map((h, i) => <div key={i} className="small chk-hint">· {h}</div>)}
            {(r.slice ?? []).map((x) => (
              <div key={String(x.support)} className="small chk-slice">
                {x.slicer}, {x.support ? t("chk.withSupport") : t("chk.noSupport")}: {t("chk.sliceRes", { s: x.support_filament_mm, tot: x.total_filament_mm, time: x.footer["estimated printing time (normal mode)"] ?? "?" })}
                {x.warnings.length ? <div className="chk-hint">⚠ {x.warnings.slice(0, 3).join(" · ")}</div> : null}
              </div>
            ))}
            {slicer ? (
              <div className="chk-actions" onClick={(e) => e.stopPropagation()}>
                <button className="tiny" disabled={p.busy} onClick={() => p.act(() => api.checks.slice(r.id, false))}>{t("chk.sliceNo")}</button>
                <button className="tiny" disabled={p.busy} onClick={() => p.act(() => api.checks.slice(r.id, true))}>{t("chk.sliceYes")}</button>
              </div>
            ) : null}
          </>}
        </div>
      ))}
      {!slicer && <div className="muted small pad-x">{t("chk.noSlicer")}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- physical tests

function Tests(p: Props & { tests: TestEntry[]; act(f: () => Promise<unknown>): Promise<void> }) {
  const t = useT();
  const empty = { title: "", result: "note", date: new Date().toISOString().slice(0, 10), observations: "", parts: "", revision: "", m: [] as { what: string; value: string; unit: string; nominal: string }[] };
  const [form, setForm] = useState<typeof empty | null>(null);
  const save = () => form && p.act(async () => {
    await api.tests.add({
      title: form.title, result: form.result, date: form.date, observations: form.observations, revision: form.revision || undefined,
      parts: form.parts.split(",").map((x) => x.trim()).filter(Boolean),
      measurements: form.m.filter((x) => x.what && x.value !== "").map((x) => ({ what: x.what, value: Number(x.value.replace(",", ".")), unit: x.unit || "mm", ...(x.nominal !== "" ? { nominal: Number(x.nominal.replace(",", ".")) } : {}) })),
    });
    setForm(null);
  });
  return (
    <div className="chk-body">
      <div className="muted small pad-x">{t("chk.testsHelp")}</div>
      {!form ? <div className="chk-actions pad-x"><button className="primary" onClick={() => setForm(empty)}>{t("chk.addTest")}</button></div> : (
        <div className="chk-form">
          <label className="chk-field">{t("chk.t.title")}<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="chk-field">{t("chk.t.result")}<span className="xyz">
            <select value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })}>{["pass", "partial", "fail", "note"].map((r) => <option key={r} value={r}>{t(`chk.res.${r}`)}</option>)}</select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </span></div>
          <label className="chk-field">{t("chk.t.obs")}<textarea rows={5} value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} /></label>
          <label className="chk-field">{t("chk.t.parts")}<input value={form.parts} onChange={(e) => setForm({ ...form, parts: e.target.value })} /></label>
          <label className="chk-field">{t("chk.t.rev")}<input value={form.revision} onChange={(e) => setForm({ ...form, revision: e.target.value })} /></label>
          <div className="chk-field">{t("chk.t.meas")}</div>
          {form.m.map((x, i) => (
            <span key={i} className="xyz meas">
              {(["what", "value", "unit", "nominal"] as const).map((k) => (
                <input key={k} placeholder={t(`chk.m.${k}`)} value={x[k]} onChange={(e) => { const m = [...form.m]; m[i] = { ...m[i], [k]: e.target.value }; setForm({ ...form, m }); }} />
              ))}
            </span>
          ))}
          <button className="link" onClick={() => setForm({ ...form, m: [...form.m, { what: "", value: "", unit: "mm", nominal: "" }] })}>{t("chk.addMeas")}</button>
          <div className="chk-actions"><button onClick={() => setForm(null)}>{t("set.cancel")}</button><button className="primary" disabled={!form.title.trim()} onClick={save}>{t("chk.save")}</button></div>
        </div>
      )}
      {!p.tests.length && <div className="muted small pad-x">{t("chk.noTests")}</div>}
      {[...p.tests].reverse().map((x) => (
        <div key={x.id} className={`chk-card ${x.result === "fail" ? "bad" : x.result === "partial" ? "warn" : x.result === "pass" ? "ok" : ""}`}>
          <div className="chk-card-title">
            <span className={`res res-${x.result}`}>{t(`chk.res.${x.result}`)}</span> {x.title}
            <button className="tiny right" title={t("chk.removeTest")} onClick={() => confirm(t("chk.removeTestQ")) && p.act(() => api.tests.remove(x.id))}>×</button>
          </div>
          <div className="muted small">{x.date}{x.revision ? ` · ${x.revision}` : ""}{x.by ? ` · ${x.by === "user" ? t("chk.byYou") : x.by}` : ""}{x.parts?.length ? ` · ${x.parts.join(", ")}` : ""}</div>
          {x.observations && <div className="small pre">{x.observations}</div>}
          {(x.measurements ?? []).map((m, i) => (
            <div key={i} className="small">{m.what}: <b>{m.value} {m.unit}</b>{m.nominal !== undefined ? ` (${t("chk.nominal")} ${m.nominal}, Δ ${(m.value - m.nominal).toFixed(3)})` : ""}</div>
          ))}
          {x.photos?.length ? <div className="muted small">{x.photos.join(", ")}</div> : null}
        </div>
      ))}
    </div>
  );
}
