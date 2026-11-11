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
  /** Bumped on project switch: results of requests started before it are dropped. */
  private gen = 0;
  /** Serial queue: each check runs after the previous one, with its own part selection. */
  private queue: Promise<unknown> = Promise.resolve();
  private pendingAuto: Promise<DesignReport> | null = null;

  constructor(private worker: CadWorker, private builder: Builder, private project: () => Project | null) {
    super();
    builder.on("result", (r: BuildResult) => this.afterBuild(r));
  }

  reset(): void {
    this.gen++;
    this.report = null;
    this.sweep = null;
    this.prints.clear();
    this.pendingAuto = null;
    this.emit("report", null);
    this.emit("sweep", null);
    this.emit("prints", []);
  }

  /** What a printability result depends on besides the geometry: placement and printer. */
  private printKey(id: string): string {
    const s = getSettings();
    const m = this.project()?.info?.placements?.[id];
    return JSON.stringify([m ?? null, s.printerBed, s.printerNozzle, s.printerLayer, s.overhangDeg]);
  }

  /** Drop printability results whose orientation or printer settings changed. */
  invalidatePrints(): void {
    let changed = false;
    for (const [id, r] of this.prints) if (r.key !== this.printKey(id)) { this.prints.delete(id); changed = true; }
    if (changed) this.emit("prints", [...this.prints.values()]);
  }

  private afterBuild(r: BuildResult): void {
    const p = this.project();
    if (!p) return;
    // Geometry changed: old printability numbers no longer apply.
    for (const part of r.parts) if (part.changed || part.stale) this.prints.delete(part.id);
    for (const id of r.removed) this.prints.delete(id);
    this.invalidatePrints();
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

  private enqueue<T>(kind: string, job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.emit("running", kind);
      try { return await job(); } finally { this.emit("running", null); }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Run the rules (and the implicit interference check) on the current build. */
  run(ids?: string[]): Promise<DesignReport> {
    // A full check that has not started yet already covers another full-check request.
    if (!ids && this.pendingAuto) return this.pendingAuto;
    const gen = this.gen;
    const job = this.enqueue("design", async () => {
      if (!ids) this.pendingAuto = null;
      const p = this.project();
      if (!p || gen !== this.gen) throw new Error("the project changed");
      const n = this.builder.last?.n ?? 0;
      let rep: DesignReport;
      const design = readDesign(p);
      try {
        const res = await this.worker.request("check_design", { rules: design.rules, near: 0.5, ids: ids ?? null, time_limit: 120 }, 180000);
        rep = { build: n, at: Date.now(), ...res };
        if (design.error) {
          rep.results = [{ id: "rules-file", kind: "rules", status: "fail", detail: design.error }, ...rep.results];
          rep.summary = { ...rep.summary, fail: rep.summary.fail + 1 };
        }
      } catch (e: any) {
        rep = { build: n, at: Date.now(), results: [], pairs: [], pair_count: 0, summary: { fail: 0, warn: 1, pass: 0 }, parts: 0, seconds: 0, error: e?.message ?? String(e) };
      }
      if (gen !== this.gen || this.project() !== p) throw new Error("the project changed");
      this.report = rep;
      this.emit("report", rep);
      return rep;
    });
    if (!ids) this.pendingAuto = job;
    return job;
  }

  /** The exact pose values of a sweep request, endpoint included, validated before any work. */
  static sweepValues(from: number, to: number, stepIn: number): number[] {
    const step = Math.abs(stepIn);
    if (![from, to, step].every(Number.isFinite) || step <= 0) throw new Error("from, to and step must be numbers, step above 0");
    const n = Math.floor(Math.abs(to - from) / step + 1e-9) + 1;
    const dir = to >= from ? 1 : -1;
    const values = Array.from({ length: Math.min(n, 401) }, (_, i) => Number((from + dir * i * step).toFixed(6)));
    if (values[values.length - 1] !== to && n <= 401) values.push(to);
    if (n > 400 || values.length > 400) throw new Error(`${Math.max(n, values.length)} poses requested: use a larger step (at most 400 poses, the end value included)`);
    return values;
  }

  runSweep(opts: { param: string; from: number; to: number; step: number; file?: string; ids?: string[]; useRules?: boolean }): Promise<SweepResult> {
    const p = this.project();
    if (!p) return Promise.reject(new Error("no project is open"));
    let values: number[];
    try { values = DesignChecks.sweepValues(opts.from, opts.to, opts.step); } catch (e) { return Promise.reject(e); }
    const gen = this.gen;
    return this.enqueue("sweep", async () => {
      const res = await this.worker.request("sweep", {
        param: opts.param, values, file: opts.file ?? null, ids: opts.ids ?? null,
        rules: opts.useRules === false ? [] : readDesign(p).rules, near: 0.5, time_limit: 900,
      }, 960000);
      if (gen !== this.gen || this.project() !== p) throw new Error("the project changed");
      this.sweep = { ...res, at: Date.now() };
      this.emit("sweep", this.sweep);
      return this.sweep!;
    });
  }

  printability(ids?: string[]): Promise<PrintReport[]> {
    const gen = this.gen;
    return this.enqueue("print", async () => {
      const s = getSettings();
      const res = await this.worker.request("printability", { ids: ids ?? null, overhang_deg: s.overhangDeg, bed: s.printerBed, nozzle: s.printerNozzle }, 300000);
      if (gen !== this.gen) throw new Error("the project changed");
      for (const r of res.parts as PrintReport[]) this.prints.set(r.id, { ...r, key: this.printKey(r.id) });
      this.emit("prints", [...this.prints.values()]);
      return res.parts;
    });
  }

  slice(id: string, support: boolean): Promise<SliceResult> {
    const p = this.project();
    if (!p) return Promise.reject(new Error("no project is open"));
    const slicer = findSlicer();
    if (!slicer) return Promise.reject(new Error("No PrusaSlicer or SuperSlicer was found. Install one, or set its path in Settings › Printing."));
    const gen = this.gen;
    return this.enqueue("slice", async () => {
      const s = getSettings();
      const key = this.printKey(id);
      const r = await this.worker.request("slice", {
        id, slicer, support, out_dir: join(p.cacheDir, "slice"),
        profile: { bed: s.printerBed, nozzle: s.printerNozzle, layer: s.printerLayer, overhang: s.overhangDeg },
      }, 360000) as SliceResult & { id: string; name: string };
      if (gen !== this.gen) throw new Error("the project changed");
      const prev = this.prints.get(id);
      const base: PrintReport = prev && prev.key === key ? prev : { id, name: r.name, key };
      const slices = (base.slice ?? []).filter((x) => x.support !== support);
      this.prints.set(id, { ...base, slice: [...slices, r].sort((a, b) => Number(a.support) - Number(b.support)) });
      this.emit("prints", [...this.prints.values()]);
      return r;
    });
  }
}

// ---------------------------------------------------------------- text for agents

export function reportText(r: DesignReport | null): string {
  if (!r) return "No design check has run yet.";
  if (r.error) return `The design check failed: ${r.error}`;
  if (r.skipped) return r.skipped;
  const lines = [`Design check on build #${r.build}: ${r.summary.fail} failed, ${r.summary.incomplete ?? 0} incomplete, ${r.summary.warn} warnings, ${r.summary.pass} passed (${r.parts} parts, ${r.seconds} s).`];
  if (r.complete === false) lines.push("INCOMPLETE: not every pair was checked, so a missing failure is not a pass.");
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
  if (!s.complete) lines.push(`NOT COMPLETE: ${s.poses_checked}/${s.values.length} poses checked${s.incomplete_poses?.length ? `; pairs left unchecked at ${s.incomplete_poses.join(", ")}` : ""}.`);
  lines.push("Only these poses were checked; motion between them is not.");
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
