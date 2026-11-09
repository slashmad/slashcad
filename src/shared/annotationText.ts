import type { Annotation } from "./types";

/** One marker as text for the agent (chat message and the list_annotations tool share this). */
export function describeAnnotation(a: Annotation): string {
  const f = a.faceInfo as any;
  const p = (v?: number[] | null) => (v ? `(${v.map((x) => Number(x).toFixed(2)).join(", ")})` : "");
  let face = a.face >= 0 ? `face ${a.face}` : "whole part";
  if (f?.type) {
    face += `: ${f.type}`;
    if (f.diameter_mm) face += ` Ø${f.diameter_mm} mm (r ${f.radius_mm}), axis ${p(f.axis)} through ${p(f.axis_point)}`;
    else if (f.radius_mm) face += ` r ${f.radius_mm} mm`;
    if (f.normal) face += `, normal ${p(f.normal)}`;
    if (f.area_mm2) face += `, area ${f.area_mm2} mm²`;
  }
  return `#${a.n} [${a.status === "done" ? "done" : "open"}] part "${a.partName}" (id ${a.partId}, source ${a.source}), ${face}; point ${p(a.point)} mm.` +
    `\n   Task: ${a.text?.trim() || "(no text)"}` + (a.agentNote ? `\n   Agent note: ${a.agentNote}` : "");
}

/** Short one-line label for lists. */
export function shortFace(a: Annotation): string {
  const f = a.faceInfo as any;
  if (a.face < 0) return a.partName;
  if (f?.diameter_mm) return `${a.partName} · ${f.type} Ø${f.diameter_mm}`;
  if (f?.type) return `${a.partName} · ${f.type}${f.radius_mm ? ` r${f.radius_mm}` : ""}`;
  return `${a.partName} · face ${a.face}`;
}
