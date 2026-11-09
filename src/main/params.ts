// Named numeric parameters at the top level of build123d scripts (e.g. `WIDTH = 120  # mm`).
// Editing one rewrites only that number in the file; the watcher then rebuilds live.
import { readFileSync, writeFileSync } from "node:fs";
import type { Param } from "../shared/types";
import type { Project } from "./project";

const RE = /^([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*(?:int|float))?\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(#.*)?$/;

export function readParams(project: Project): Param[] {
  const out: Param[] = [];
  for (const file of project.info.scene.filter((f) => f.endsWith(".py"))) {
    let text = "";
    try { text = readFileSync(project.abs(file), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      const m = line.match(RE);
      if (!m || m[1].startsWith("_")) return;
      const raw = m[3];
      out.push({ file, name: m[1], value: Number(raw), line: i + 1, comment: m[4]?.replace(/^#\s*/, "") ?? "", integer: !/[.eE]/.test(raw) });
    });
  }
  return out;
}

export function writeParam(project: Project, file: string, line: number, name: string, value: number): void {
  const abs = project.abs(file);
  const lines = readFileSync(abs, "utf8").split("\n");
  const cur = lines[line - 1] ?? "";
  const m = cur.match(RE);
  if (!m || m[1] !== name) throw new Error(`parameter ${name} was not found on line ${line} (the file has changed)`);
  const isInt = !/[.eE]/.test(m[3]) && Number.isInteger(value);
  const formatted = isInt ? String(Math.round(value)) : String(Number(value.toPrecision(12)));
  lines[line - 1] = cur.replace(RE, (_all, n, ann, _v, comment) => `${n}${ann ?? ""} = ${formatted}${comment ? `  ${comment}` : ""}`);
  writeFileSync(abs, lines.join("\n"));
}
