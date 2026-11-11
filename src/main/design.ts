// Project design files owned by the user, kept beside the models so they can be versioned:
//  - slashcad.rules.json: design rules checked after builds (clearances, intended contacts,
//    envelope, protected parts, retention, assembly paths), project materials, default sweep;
//  - slashcad.tests.json: the physical test log (prints, fits, measurements). It is the primary
//    evidence: a nominal CAD check never overrides what was observed on a real part.
// Single-file mode keeps both in the per-file state folder so nothing is written beside the file.
// Writes go through the file watcher, so they are undoable like any other text edit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesignFile, DesignRule, RuleKind, TestEntry } from "../shared/types";
import type { Project } from "./project";

export const RULES_FILE = "slashcad.rules.json";
export const TESTS_FILE = "slashcad.tests.json";
const KINDS: RuleKind[] = ["interference", "allow_contact", "clearance", "envelope", "protected", "retained", "path_clear"];

function pathFor(p: Project, name: string): string {
  return p.singleFile ? join(p.stateDir, name) : p.abs(name);
}

export function rulesPath(p: Project): string { return pathFor(p, RULES_FILE); }
export function testsPath(p: Project): string { return pathFor(p, TESTS_FILE); }

export function hasRules(p: Project): boolean { return existsSync(rulesPath(p)); }

export function readDesign(p: Project): DesignFile {
  try {
    const j = JSON.parse(readFileSync(rulesPath(p), "utf8"));
    const rules = Array.isArray(j.rules) ? j.rules.filter((r: any) => r && KINDS.includes(r.kind)) : [];
    return { version: 1, rules, materials: j.materials && typeof j.materials === "object" ? j.materials : undefined, sweep: j.sweep };
  } catch {
    return { version: 1, rules: [] };
  }
}

function writeDesign(p: Project, d: DesignFile): void {
  const out: DesignFile = { version: 1, rules: d.rules };
  if (d.materials && Object.keys(d.materials).length) out.materials = d.materials;
  if (d.sweep) out.sweep = d.sweep;
  const file = rulesPath(p);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Check a rule from an agent or the UI; returns a cleaned copy with an id. */
export function normaliseRule(r: any, existing: DesignRule[]): DesignRule {
  if (!r || typeof r !== "object") throw new Error("a rule must be an object");
  if (!KINDS.includes(r.kind)) throw new Error(`unknown rule kind ${r.kind}; use one of ${KINDS.join(", ")}`);
  const need = (k: string) => { if (r[k] === undefined || r[k] === null || r[k] === "") throw new Error(`a ${r.kind} rule needs "${k}"`); };
  const num = (k: string) => { if (r[k] !== undefined && !Number.isFinite(Number(r[k]))) throw new Error(`"${k}" must be a number`); };
  switch (r.kind) {
    case "clearance": need("a"); need("b"); need("min"); num("min"); break;
    case "allow_contact": need("a"); need("b"); break;
    case "envelope": need("max"); if (!Array.isArray(r.max) || r.max.length !== 3) throw new Error('"max" must be [x, y, z] (null for no limit)'); break;
    case "protected": need("fingerprints"); break;
    case "retained": need("part"); need("within"); num("within"); break;
    case "path_clear": need("part"); need("distance"); num("distance"); if (!r.direction && !r.directions) throw new Error('a path_clear rule needs "direction" [x, y, z]'); break;
  }
  const base = String(r.id || `${r.kind}-${(r.a ?? r.part ?? r.parts ?? "all").toString().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 24) || "rule"}`);
  let id = base;
  for (let i = 2; existing.some((e) => e.id === id); i++) id = `${base}-${i}`;
  const clean: any = { ...r, id };
  for (const k of ["min", "within", "distance", "step"]) if (clean[k] !== undefined) clean[k] = Number(clean[k]);
  return clean as DesignRule;
}

export function addRule(p: Project, rule: any): DesignRule {
  const d = readDesign(p);
  const r = normaliseRule(rule, d.rules);
  d.rules.push(r);
  writeDesign(p, d);
  return r;
}

export function removeRule(p: Project, id: string): boolean {
  const d = readDesign(p);
  const n = d.rules.length;
  d.rules = d.rules.filter((r) => r.id !== id);
  if (d.rules.length === n) return false;
  writeDesign(p, d);
  return true;
}

export function setSweep(p: Project, sweep: DesignFile["sweep"]): void {
  const d = readDesign(p);
  d.sweep = sweep;
  writeDesign(p, d);
}

export { describeRule } from "../shared/ruleText";

// ---------------------------------------------------------------- physical test log

export function readTests(p: Project): TestEntry[] {
  try {
    const j = JSON.parse(readFileSync(testsPath(p), "utf8"));
    return Array.isArray(j.tests) ? j.tests : [];
  } catch {
    return [];
  }
}

function writeTests(p: Project, list: TestEntry[]): void {
  const file = testsPath(p);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, tests: list }, null, 2) + "\n");
}

export function addTest(p: Project, t: Partial<TestEntry>, by: string): TestEntry {
  if (!t.title || !String(t.title).trim()) throw new Error("a test entry needs a title");
  const result = ["pass", "fail", "partial", "note"].includes(String(t.result)) ? t.result as TestEntry["result"] : "note";
  const list = readTests(p);
  const entry: TestEntry = {
    id: `t${Date.now().toString(36)}`,
    date: t.date && /^\d{4}-\d{2}-\d{2}/.test(t.date) ? t.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    title: String(t.title).trim().slice(0, 200),
    result,
    observations: String(t.observations ?? "").slice(0, 8000),
    parts: Array.isArray(t.parts) ? t.parts.map(String).slice(0, 50) : undefined,
    measurements: Array.isArray(t.measurements)
      ? t.measurements.filter((m) => m && m.what && Number.isFinite(Number(m.value))).map((m) => ({
        what: String(m.what), value: Number(m.value), unit: String(m.unit ?? "mm"), ...(m.nominal !== undefined && Number.isFinite(Number(m.nominal)) ? { nominal: Number(m.nominal) } : {}),
      }))
      : undefined,
    photos: Array.isArray(t.photos) ? t.photos.map(String).slice(0, 30) : undefined,
    revision: t.revision ? String(t.revision).slice(0, 60) : undefined,
    by,
    createdAt: Date.now(),
  };
  list.push(entry);
  writeTests(p, list);
  return entry;
}

export function updateTest(p: Project, id: string, patch: Partial<TestEntry>): TestEntry | null {
  const list = readTests(p);
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id };
  writeTests(p, list);
  return list[i];
}

export function removeTest(p: Project, id: string): boolean {
  const list = readTests(p);
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeTests(p, next);
  return true;
}

export function describeTest(t: TestEntry): string {
  const lines = [`[${t.id}] ${t.date} ${t.result.toUpperCase()}: ${t.title}${t.revision ? ` (revision ${t.revision})` : ""}${t.by ? ` – logged by ${t.by}` : ""}`];
  if (t.parts?.length) lines.push(`  parts: ${t.parts.join(", ")}`);
  if (t.observations) lines.push(...t.observations.split("\n").map((l) => `  ${l}`));
  for (const m of t.measurements ?? []) lines.push(`  measured ${m.what}: ${m.value} ${m.unit}${m.nominal !== undefined ? ` (nominal ${m.nominal} ${m.unit}, Δ ${(m.value - m.nominal).toFixed(3)})` : ""}`);
  if (t.photos?.length) lines.push(`  photos: ${t.photos.join(", ")}`);
  return lines.join("\n");
}
