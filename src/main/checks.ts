// Design checks around the CAD worker: rule checks after builds, motion sweeps, printability and
// analysis slicing. Results are kept as data (last report per kind) for the UI and the agents.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BuildResult, DesignReport, PrintReport, SliceResult, SweepResult } from "../shared/types";
import type { Builder } from "./builder";
import type { CadWorker } from "./cadWorker";
import { hasRules, readDesign } from "./design";
import type { Project } from "./project";
import { getSettings } from "./settings";

/** Automatic checks after a build stop above this many parts (manual runs still work). */
export const AUTO_CHECK_MAX_PARTS = 150;

const SLICERS = ["prusa-slicer", "PrusaSlicer", "superslicer", "SuperSlicer", "prusa-slicer-console.exe", "superslicer_console.exe"];

export function findSlicer(): string | null {
  const s = getSettings().slicerPath;
  if (s && existsSync(s)) return s;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of SLICERS) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export class DesignChecks extends EventEmitter {
  report: DesignReport | null = null;
  sweep: SweepResult | null = null;
  prints = new Map<string, PrintReport>();
  private running: Promise<DesignReport> | null = null;
  private again = false;

  constructor(private worker: CadWorker, private builder: Builder, private project: () => Project | null) {
    super();
    builder.on("result", (r: BuildResult) => this.afterBuild(r));
  }

  reset(): void {
    this.report = null;
    this.sweep = null;
    this.prints.clear();
    this.emit("report", null);
    this.emit("sweep", null);
    this.emit("prints", []);
  }

  private afterBuild(r: BuildResult): void {
    const p = this.project();
    if (!p) return;
    // Geometry changed: old printability numbers no longer apply.
    for (const part of r.parts) if (part.changed) this.prints.delete(part.id);
    for (const id of r.removed) this.prints.delete(id);
    this.emit("prints", [...this.prints.values()]);
    if (!hasRules(p)) {
      if (this.report) { this.report = null; this.emit("report", null); }
      return;
    }
    if (r.parts.length > AUTO_CHECK_MAX_PARTS) {
      this.report = { build: r.n, at: Date.now(), results: [], pairs: [], pair_count: 0, summary: { fail: 0, warn: 0, pass: 0 }, parts: r.parts.length, seconds: 0,
        skipped: `${r.parts.length} parts: automatic checks run up to ${AUTO_CHECK_MAX_PARTS}. Run them by hand.` };
      this.emit("report", this.report);
      return;
    }
    this.run().catch(() => {});
  }

  /** Run the rules (and the implicit interference check) on the current build. */
  run(ids?: string[]): Promise<DesignReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const p = this.project();
    if (!p) return Promise.reject(new Error("no project is open"));
    const n = this.builder.last?.n ?? 0;
    this.emit("running", "design");
    this.running = (async () => {
      try {
        const res = await this.worker.request("check_design", { rules: readDesign(p).rules, near: 0.5, ids: ids ?? null, time_limit: 120 }, 180000);
        this.report = { build: n, at: Date.now(), ...res };
      } catch (e: any) {
        this.report = { build: n, at: Date.now(), results: [], pairs: [], pair_count: 0, summary: { fail: 0, warn: 1, pass: 0 }, parts: 0, seconds: 0, error: e?.message ?? String(e) };
      } finally {
        this.running = null;
      }
      this.emit("report", this.report);
      this.emit("running", null);
      if (this.again) { this.again = false; this.run().catch(() => {}); }
      return this.report!;
    })();
    return this.running;
  }

  async runSweep(opts: { param: string; from: number; to: number; step: number; file?: string; ids?: string[]; useRules?: boolean }): Promise<SweepResult> {
    const p = this.project();
    if (!p) throw new Error("no project is open");
    const { from, to } = opts;
    const step = Math.abs(opts.step) || 1;
    if (![from, to, step].every(Number.isFinite)) throw new Error("from, to and step must be numbers");
    const n = Math.floor(Math.abs(to - from) / step + 1e-9) + 1;
    if (n > 400) throw new Error(`${n} poses: use a larger step (at most 400 poses)`);
    const dir = to >= from ? 1 : -1;
    const values = Array.from({ length: n }, (_, i) => Number((from + dir * i * step).toFixed(6)));
    if (values[values.length - 1] !== to) values.push(to);
    this.emit("running", "sweep");
    try {
      const res = await this.worker.request("sweep", {
        param: opts.param, values, file: opts.file ?? null, ids: opts.ids ?? null,
        rules: opts.useRules === false ? [] : readDesign(p).rules, near: 0.5, time_limit: 900,
      }, 960000);
      this.sweep = { ...res, at: Date.now() };
      this.emit("sweep", this.sweep);
      return this.sweep!;
    } finally {
      this.emit("running", null);
    }
  }

  async printability(ids?: string[]): Promise<PrintReport[]> {
    const s = getSettings();
    this.emit("running", "print");
    try {
      const res = await this.worker.request("printability", { ids: ids ?? null, overhang_deg: s.overhangDeg, bed: s.printerBed, nozzle: s.printerNozzle }, 300000);
      for (const r of res.parts as PrintReport[]) this.prints.set(r.id, { ...this.prints.get(r.id), ...r });
      this.emit("prints", [...this.prints.values()]);
      return res.parts;
    } finally {
      this.emit("running", null);
    }
  }

  async slice(id: string, support: boolean): Promise<SliceResult> {
    const p = this.project();
    if (!p) throw new Error("no project is open");
    const slicer = findSlicer();
    if (!slicer) throw new Error("No PrusaSlicer or SuperSlicer was found. Install one, or set its path in Settings › Printing.");
    const s = getSettings();
    this.emit("running", "slice");
    try {
      const r = await this.worker.request("slice", {
        id, slicer, support, out_dir: join(p.cacheDir, "slice"),
        profile: { bed: s.printerBed, nozzle: s.printerNozzle, layer: s.printerLayer, overhang: s.overhangDeg },
      }, 360000) as SliceResult & { id: string; name: string };
      const prev = this.prints.get(id) ?? { id, name: r.name };
      const slices = (prev.slice ?? []).filter((x) => x.support !== support);
      this.prints.set(id, { ...prev, slice: [...slices, r].sort((a, b) => Number(a.support) - Number(b.support)) });
      this.emit("prints", [...this.prints.values()]);
      return r;
    } finally {
      this.emit("running", null);
    }
  }
}

// ---------------------------------------------------------------- text for agents

export function reportText(r: DesignReport | null): string {
  if (!r) return "No design check has run yet.";
  if (r.error) return `The design check failed: ${r.error}`;
  if (r.skipped) return r.skipped;
  const lines = [`Design check on build #${r.build}: ${r.summary.fail} failed, ${r.summary.warn} warnings, ${r.summary.pass} passed (${r.parts} parts, ${r.seconds} s).`];
  for (const x of r.results) lines.push(`- ${x.status.toUpperCase()} ${x.id} (${x.kind}): ${x.detail}`);
  const close = r.pairs.filter((p) => p.kind !== "interference").slice(0, 12);
  if (close.length) {
    lines.push("Closest pairs (touching or within 0.5 mm):");
    for (const p of close) lines.push(`  ${p.a_name} ↔ ${p.b_name}: ${p.kind === "touch" ? "touching" : `${p.distance_mm} mm`}${p.allowed_by ? ` (allowed by ${p.allowed_by})` : ""}`);
  }
  lines.push("Nominal rigid geometry only: deflection under load, print tolerances and assembly order are not covered unless a rule tests them.");
  return lines.join("\n");
}

export function sweepText(s: SweepResult): string {
  const lines = [`Sweep of ${s.param} over ${s.values[0]}…${s.values[s.values.length - 1]} (${s.poses_checked}/${s.values.length} poses, ${s.seconds} s; scripts ${(s.scripts ?? []).join(", ")}).`];
  if (!s.complete) lines.push("NOT COMPLETE: the time limit stopped the sweep.");
  const bad = s.failing_poses ?? [];
  lines.push(bad.length ? `Failing poses (interference, rule failure or build error): ${bad.join(", ")}` : "No pose has an unintended interference or rule failure.");
  const poses = s.poses ?? [];
  for (const p of poses.filter((x) => x.interferences || x.rule_failures?.length || x.errors?.length).slice(0, 15)) {
    const w = p.worst;
    lines.push(`  ${s.param} = ${p.value}: ${p.interferences} interference(s)${w ? `, worst ${w.a_name} ↔ ${w.b_name} ${w.overlap_mm3 ?? "?"} mm³` : ""}${(p.rule_failures ?? []).map((f) => `; ${f.id}: ${f.detail}`).join("")}${p.errors?.length ? `; errors: ${p.errors.join("; ")}` : ""}`);
  }
  lines.push(`Closest pairs over the sweep (min clearance, at ${s.param}):`);
  const close = s.closest_pairs ?? [];
  for (const c of close.slice(0, 15)) {
    lines.push(`  ${c.a_name} ↔ ${c.b_name}: ${c.kind === "interference" ? `overlap ${c.max_overlap_mm3} mm³` : c.kind === "touch" ? "touching" : `${c.min_distance_mm} mm`} at ${c.at}${c.allowed_by ? ` (allowed by ${c.allowed_by})` : ""}`);
  }
  if (!close.length) lines.push(`  none within ${s.near_mm ?? 0.5} mm`);
  return lines.join("\n");
}

export function printText(list: PrintReport[], bedNote: string): string {
  const lines: string[] = [`Printability (${bedNote}; bed = lowest Z of the placed part):`];
  for (const r of list) {
    if (r.error) { lines.push(`- ${r.name}: ${r.error}`); continue; }
    lines.push(`- ${r.name} [${r.id}]: ${r.size_mm?.join(" × ")} mm, ${r.fits_bed ? "fits the bed" : "DOES NOT FIT the bed"}; overhang ${r.overhang_mm2} mm² (flat ${r.flat_down_mm2} mm²), bed contact ${r.bed_contact_mm2} mm²; best orientation: ${r.best_orientation}`);
    for (const h of r.hints ?? []) lines.push(`    · ${h}`);
    for (const s of r.slice ?? []) lines.push(`    slicer (${s.slicer}, ${s.support ? "with" : "without"} support): support ${s.support_filament_mm} mm of ${s.total_filament_mm} mm filament, ${s.footer["estimated printing time (normal mode)"] ?? "?"}${s.warnings.length ? `; warnings: ${s.warnings.join(" | ")}` : ""}`);
  }
  lines.push("Geometric estimate, not a print result: thin walls, bridges and real printer tolerances still need a test print.");
  return lines.join("\n");
}
