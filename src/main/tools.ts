// CAD tools exposed to agents through the MCP hub.
import { relative } from "node:path";
import type { BuildResult, SnapshotRequest, ViewName } from "../shared/types";
import { Annotations } from "./annotations";
import type { Builder } from "./builder";
import type { CadWorker } from "./cadWorker";
import { VIEW_ENUM, type McpHub, type ToolResult } from "./mcpHub";
import type { Project } from "./project";

export interface ToolContext {
  builder: Builder;
  worker: CadWorker;
  project(): Project | null;
  annotations(): Annotations | null;
  snapshot(req: Omit<SnapshotRequest, "reqId">): Promise<string>; // data URL (PNG)
  highlight(ids: string[], message?: string): void;
  sceneChanged(): void;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });

function dims(b: BuildResult["parts"][number]["bbox"]): string {
  return b[1].map((v, i) => (v - b[0][i]).toFixed(2)).join(" × ");
}

export function buildSummary(r: BuildResult, project: Project): string {
  const lines: string[] = [`Build #${r.n} finished in ${r.seconds.toFixed(2)} s (quality ${r.quality}).`];
  for (const s of r.sources) {
    if (s.error) {
      lines.push(`ERROR in ${s.source}${s.error.line ? ` line ${s.error.line}` : ""}: ${s.error.message}`);
      const tb = s.error.traceback.trim().split("\n").slice(-12).join("\n");
      if (tb) lines.push(tb);
    } else lines.push(`OK ${s.source}: ${s.parts} part(s), ${s.seconds.toFixed(2)} s`);
    const log = s.log.trim();
    if (log) lines.push(`output from ${s.source}:\n${log.split("\n").slice(-20).join("\n")}`);
  }
  const changed = r.parts.filter((p) => p.changed).map((p) => p.name);
  lines.push(`Parts (${r.parts.length}), size X × Y × Z mm:`);
  for (const p of r.parts.slice(0, 80)) lines.push(`- ${p.name} [id ${p.id}] ${dims(p.bbox)}${p.changed ? " (changed)" : ""}${p.stale ? " (stale: its source has an error)" : ""}`);
  if (r.parts.length > 80) lines.push(`… and ${r.parts.length - 80} more`);
  if (r.removed.length) lines.push(`Removed: ${r.removed.join(", ")}`);
  if (changed.length) lines.push(`Changed: ${changed.join(", ")}`);
  lines.push(`Scene: ${project.info.scene.join(", ") || "(empty)"}`);
  if (project.singleFile) lines.push(`Single-file mode: only ${project.singleFile} is open (no project). To add geometry, ask the user to click "Make project" in the top bar.`);
  const blocked = project.info.trusted ? [] : project.info.scene.filter((s) => s.endsWith(".py"));
  if (blocked.length) lines.push(`NOTE: scripts are not run because the user has not trusted this folder yet: ${blocked.join(", ")}. Ask the user to click "Trust and build" in SlashCAD.`);
  return lines.join("\n");
}

export function registerTools(hub: McpHub, ctx: ToolContext): void {
  const need = () => {
    const p = ctx.project();
    if (!p) throw new Error("No project is open in SlashCAD.");
    return p;
  };

  hub.register("get_scene", {
    description: "Current project, which source files are shown, and the parts/errors of the latest build.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const p = need();
      const last = ctx.builder.last;
      return text(last ? buildSummary(last, p) : `Project ${p.dir}. Scene: ${p.info.scene.join(", ") || "(empty)"}. No build yet.`);
    },
  });

  hub.register("build", {
    description: "Rebuild the shown sources now and return per-source errors (with line numbers), parts, sizes and timings. Files also rebuild automatically on save.",
    inputSchema: { type: "object", properties: { sources: { type: "array", items: { type: "string" }, description: "Optional: replace the shown sources (project-relative paths) before building." } } },
    async run(a) {
      const p = need();
      if (Array.isArray(a.sources)) { p.setScene(a.sources); ctx.sceneChanged(); }
      const r = await ctx.builder.request("agent");
      return text(buildSummary(r, p), r.sources.some((s) => s.error));
    },
    summarize: (_a, r) => (r.isError ? "Build with errors" : "Build OK"),
  });

  hub.register("set_scene", {
    description: "Choose which project files (.py build123d scripts, .step/.stp, .brep) are shown and built.",
    inputSchema: { type: "object", properties: { sources: { type: "array", items: { type: "string" } } }, required: ["sources"] },
    async run(a) {
      const p = need();
      p.setScene(a.sources ?? []);
      ctx.sceneChanged();
      const r = await ctx.builder.request("scene");
      return text(buildSummary(r, p));
    },
  });

  hub.register("inspect", {
    description: "Exact B-rep properties per part: volume (mm³), area (mm²), bounding box, centre of mass, validity, solid/face/edge counts.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Part ids from build/get_scene; omit for all." } } },
    async run(a) {
      need();
      const r = await ctx.worker.request("inspect", { ids: a.ids ?? null });
      return text(JSON.stringify(r.parts, null, 1));
    },
  });

  hub.register("measure", {
    description: "Minimum distance between two parts and their intersection (interference) volume.",
    inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    async run(a) {
      need();
      return text(JSON.stringify(await ctx.worker.request("measure", { a: a.a, b: a.b }), null, 1));
    },
  });

  hub.register("render_view", {
    description: "Render the current model to a PNG from a standard view. The user's own camera is not changed. Images cost context: request them when they add information.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: VIEW_ENUM, description: "iso (default), front, back, left, right, top, bottom, or current (the user's view)" },
        width: { type: "integer", minimum: 200, maximum: 1600 },
        height: { type: "integer", minimum: 200, maximum: 1600 },
        highlight: { type: "array", items: { type: "string" }, description: "Part ids to highlight" },
        parts: { type: "array", items: { type: "string" }, description: "Only show these part ids" },
      },
    },
    async run(a) {
      need();
      const view: ViewName = VIEW_ENUM.includes(a.view) ? a.view : "iso";
      const url = await ctx.snapshot({ view, width: a.width ?? 900, height: a.height ?? 650, highlight: a.highlight, parts: a.parts });
      const data = url.replace(/^data:image\/png;base64,/, "");
      return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `View: ${view}` }] };
    },
    summarize: (a) => `Image ${a.view ?? "iso"}`,
  });

  hub.register("highlight", {
    description: "Highlight parts in the user's live 3D view (e.g. while explaining a change). Does not move their camera unless focus is true.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, message: { type: "string" }, focus: { type: "boolean" } }, required: ["ids"] },
    async run(a) {
      ctx.highlight(a.ids ?? [], a.message);
      return text(`Highlighted ${a.ids?.length ?? 0} part(s) for the user.`);
    },
  });

  hub.register("list_annotations", {
    description: "Markers the user placed on faces in the 3D view, each with a task (numbered pins, also visible in render_view images). Includes face geometry (type, diameter, axis, normal). Work through open ones and call resolve_annotation when done.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "done", "all"], description: "default open" } } },
    async run(a) {
      need();
      const list = (ctx.annotations()?.list() ?? []).filter((x) => (a.status ?? "open") === "all" || x.status === (a.status ?? "open"));
      if (!list.length) return text("No markers with that status.");
      return text(list.map((x) => Annotations.describe(x)).join("\n"));
    },
    summarize: (_a, r) => r.content[0]?.type === "text" ? `${(r.content[0].text.match(/^#/gm) ?? []).length} marker(s)` : "",
  });

  hub.register("resolve_annotation", {
    description: "Mark one of the user's markers as done, with a short note on what you changed. Use the number (e.g. 3 or #3) or id.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id", "note"] },
    async run(a) {
      need();
      const r = ctx.annotations()?.update(String(a.id), { status: "done", agentNote: a.note });
      return r ? text(`Marker #${r.n} marked as done.`) : text(`No marker ${a.id} found.`, true);
    },
    summarize: (a) => `Marker ${a.id} done`,
  });

  hub.register("export", {
    description: "Export parts to a file inside the project: step, stl, glb or brep.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["step", "stl", "glb", "brep"] }, path: { type: "string", description: "Project-relative output path" }, ids: { type: "array", items: { type: "string" } } },
      required: ["format", "path"],
    },
    async run(a) {
      const p = need();
      const abs = p.abs(a.path);
      const r = await ctx.worker.request("export", { format: a.format, path: abs, ids: a.ids ?? null }, 600000);
      return text(`Exported ${r.parts} part(s) to ${relative(p.dir, r.path)} (${(r.bytes / 1e6).toFixed(2)} MB).`);
    },
  });
}
