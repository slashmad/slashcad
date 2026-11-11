// Human-readable rule text, shared by the main process (agent tools) and the renderer.
import type { DesignRule } from "./types";

/** [0,0,1] → "+Z"; other vectors as written. */
export function dirText(d: unknown): string {
  const one = (v: unknown): string => {
    if (!Array.isArray(v) || v.length !== 3) return JSON.stringify(v);
    const nz = v.map(Number).map((x, i) => [x, i] as const).filter(([x]) => x !== 0);
    return nz.length === 1 ? `${nz[0][0] > 0 ? "+" : "−"}${"XYZ"[nz[0][1]]}` : `[${v.join(", ")}]`;
  };
  return Array.isArray(d) && Array.isArray(d[0]) ? d.map(one).join(", ") : one(d);
}

export function describeRule(r: DesignRule): string {
  const list = (x: unknown) => (Array.isArray(x) ? x.join("|") : String(x ?? "*"));
  switch (r.kind) {
    case "clearance": return `clearance ${list(r.a)} ↔ ${list(r.b)} ≥ ${r.min} mm`;
    case "allow_contact": return `intended contact ${list(r.a)} ↔ ${list(r.b)}`;
    case "envelope": return `envelope of ${list(r.parts)} ≤ ${(r.max ?? []).map((v) => (v === null ? "–" : v)).join(" × ")} mm`;
    case "protected": return `protected geometry: ${Object.keys(r.fingerprints ?? {}).map((k) => k.split("#").pop()).join(", ")}`;
    case "retained": return `${list(r.part)} retained by ${list(r.against)} within ${r.within} mm along ${dirText(r.directions ?? r.direction ?? [0, 0, 1])}`;
    case "path_clear": return `${list(r.part)} free path ${r.distance} mm along ${dirText(r.directions ?? r.direction)}${r.against ? ` past ${list(r.against)}` : ""}`;
    case "interference": return r.enabled === false ? "interference check off" : "no unintended interference";
  }
  return r.kind;
}
