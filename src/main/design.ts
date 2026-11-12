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
  let text: string;
  try { text = readFileSync(rulesPath(p), "utf8"); } catch { return { version: 1, rules: [] }; } // no rules file
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("the file is not a JSON object");
    if (j.version !== undefined && j.version !== 1) {
      return { version: 1, rules: [], error: `${RULES_FILE} has version ${JSON.stringify(j.version)}, which this SlashCAD does not know; no rules were checked`, unreadable: true };
    }
    if (j.rules !== undefined && !Array.isArray(j.rules)) throw new Error('"rules" must be a list');
    const all: any[] = j.rules ?? [];
    const rules: DesignRule[] = [];
    const problems: string[] = [];
    all.forEach((r, i) => {
      try {
        validateRule(r);
        rules.push(r.id ? r : { ...r, id: `${r.kind}-${i + 1}` });
      } catch (e: any) {
        problems.push(`rule ${i + 1}${r?.id ? ` (${r.id})` : ""}: ${e?.message ?? e}`);
      }
    });
    return {
      version: 1, rules, materials: j.materials && typeof j.materials === "object" ? j.materials : undefined, sweep: j.sweep,
      // Invalid rules are not dropped silently: the check reports them as a failure.
      ...(problems.length ? { error: `${problems.length} rule(s) in ${RULES_FILE} are invalid and were not checked: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? " …" : ""}` } : {}),
    };
  } catch (e: any) {
    // A broken file must never read as "no rules": that would turn every check into a pass.
    return { version: 1, rules: [], error: `${RULES_FILE} could not be read (${e?.message ?? e}); no rules were checked`, unreadable: true };
  }
}

function writable(p: Project): DesignFile {
  const d = readDesign(p);
  // Rewriting would drop what could not be read: leave the user's file untouched until it is fixed.
  if (d.error) throw new Error(`${d.error}. Fix the file by hand first; SlashCAD will not overwrite it.`);
  return d;
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
/** Throws when a rule lacks a field its kind needs or has a field of the wrong type. Used for rules
 *  written by hand as well as rules added through the app, so a typo never becomes a silent pass. */
export function validateRule(r: any): void {
  if (!r || typeof r !== "object") throw new Error("a rule must be an object");
  if (!KINDS.includes(r.kind)) throw new Error(`unknown rule kind ${JSON.stringify(r.kind)}; use one of ${KINDS.join(", ")}`);
  const need = (k: string) => { if (r[k] === undefined || r[k] === null || r[k] === "" || (Array.isArray(r[k]) && !r[k].length)) throw new Error(`a ${r.kind} rule needs "${k}"`); };
  const num = (k: string, positive = false) => {
    if (r[k] === undefined) return;
    const v = Number(r[k]);
    if (typeof r[k] === "boolean" || !Number.isFinite(v)) throw new Error(`"${k}" must be a number`);
    if (positive && !(v > 0)) throw new Error(`"${k}" must be above 0`);
  };
  const vec = (v: unknown, what: string) => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x))) || v.every((x) => Number(x) === 0)) throw new Error(`"${what}" must be a non-zero [x, y, z]`);
  };
  const globs = (k: string) => { if (r[k] !== undefined && typeof r[k] !== "string" && !(Array.isArray(r[k]) && r[k].every((x: unknown) => typeof x === "string"))) throw new Error(`"${k}" must be a name pattern or a list of them`); };
  ["a", "b", "part", "parts", "against"].forEach(globs);
  num("step", true);
  switch (r.kind) {
    case "clearance": need("a"); need("b"); need("min"); num("min"); if (Number(r.min) < 0) throw new Error('"min" must not be negative'); break;
    case "allow_contact": need("a"); need("b"); break;
    case "envelope":
      need("max");
      if (!Array.isArray(r.max) || r.max.length !== 3 || !r.max.every((x: unknown) => x === null || Number.isFinite(Number(x)))) throw new Error('"max" must be [x, y, z] (null for no limit)');
      if (r.max.every((x: unknown) => x === null)) throw new Error('"max" needs at least one limit');
      break;
    case "protected":
      need("fingerprints");
      if (typeof r.fingerprints !== "object" || Array.isArray(r.fingerprints) || !Object.keys(r.fingerprints).length) throw new Error('"fingerprints" must name at least one part');
      break;
    case "retained":
      need("part"); need("within"); num("within", true);
      if (r.directions !== undefined) { if (!Array.isArray(r.directions) || !r.directions.length) throw new Error('"directions" must be a list of [x, y, z]'); r.directions.forEach((d: unknown) => vec(d, "directions")); }
      if (r.direction !== undefined) vec(r.direction, "direction");
      break;
    case "path_clear":
      need("part"); need("distance"); num("distance", true);
      if (!r.direction && !r.directions) throw new Error('a path_clear rule needs "direction" [x, y, z]');
      if (r.direction !== undefined) vec(r.direction, "direction");
      if (r.directions !== undefined) { if (!Array.isArray(r.directions) || !r.directions.length) throw new Error('"directions" must be a list of [x, y, z]'); r.directions.forEach((d: unknown) => vec(d, "directions")); }
      break;
    case "interference":
      if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error('"enabled" must be true or false');
      break;
  }
}

export function normaliseRule(r: any, existing: DesignRule[]): DesignRule {
  validateRule(r);
  const base = String(r.id || `${r.kind}-${(r.a ?? r.part ?? r.parts ?? "all").toString().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 24) || "rule"}`);
  let id = base;
  for (let i = 2; existing.some((e) => e.id === id); i++) id = `${base}-${i}`;
  const clean: any = { ...r, id };
  for (const k of ["min", "within", "distance", "step"]) if (clean[k] !== undefined) clean[k] = Number(clean[k]);
  return clean as DesignRule;
}

export function addRule(p: Project, rule: any): DesignRule {
  const d = writable(p);
  const r = normaliseRule(rule, d.rules);
  d.rules.push(r);
  writeDesign(p, d);
  return r;
}

export function removeRule(p: Project, id: string): boolean {
  const d = writable(p);
  const n = d.rules.length;
  d.rules = d.rules.filter((r) => r.id !== id);
  if (d.rules.length === n) return false;
  writeDesign(p, d);
  return true;
}

export function setSweep(p: Project, sweep: DesignFile["sweep"]): void {
  const d = writable(p);
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
