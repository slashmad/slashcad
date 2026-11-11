// CAD tools exposed to agents through the MCP hub.
import { relative } from "node:path";
import type { BuildResult, PosePreview, SnapshotRequest, ViewName } from "../shared/types";
import { Annotations } from "./annotations";
import type { Builder } from "./builder";
import type { CadWorker } from "./cadWorker";
import { printText, reportText, sweepText, type DesignChecks } from "./checks";
import { addRule, addTest, describeRule, describeTest, readDesign, readTests, removeRule, RULES_FILE, TESTS_FILE } from "./design";
import { getSettings } from "./settings";
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
  fetchReference(url: string, filename?: string, folder?: string): Promise<{ path: string; bytes: number; sha256: string; contentType: string }>;
  checks: DesignChecks;
  /** Ask the user in SlashCAD (yes/no). Used for agent writes to the user's rules and test log. */
  confirm(message: string, detail: string, yes: string): Promise<boolean>;
  agentName(): string;
  setPreview(p: PosePreview | null): Promise<BuildResult>;
  /** Rules or the test log were written: refresh the user's panels. */
  designChanged(): void;
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
  if (r.preview) lines.push(`POSE PREVIEW: the view shows ${r.preview.param} = ${r.preview.value} from ${r.preview.file} (not saved in the file). Clear it with show_pose {clear: true}.`);
  if (changed.length) lines.push(`Changed: ${changed.join(", ")}`);
  lines.push(`Scene: ${project.info.scene.join(", ") || "(empty)"}`);
  const placed = Object.keys(project.info.placements ?? {});
  if (placed.length) lines.push(`Placed by the user in the view (moved/rotated on top of the script's coordinates; sizes above, inspect, measure and export use the placed geometry): ${placed.slice(0, 40).join(", ")}${placed.length > 40 ? " …" : ""}`);
  if (project.singleFile) lines.push(`Single-file mode: only ${project.singleFile} is open (no project). To add geometry, ask the user to click "Make project" in the top bar.`);
  const mats = [...new Set(r.parts.map((p) => p.material).filter(Boolean))];
  if (mats.length) lines.push(`Materials: ${mats.join(", ")} (inspect gives mass and centre of mass).`);
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

  hub.register("fetch_reference", {
    description: "Download a reference file (datasheet PDF, drawing, image, or a vendor STEP/STL model) from a direct http(s) URL into the project, by default into references/. The user confirms every download in SlashCAD. Only data files are accepted: step, stp, iges, igs, brep, stl, 3mf, obj, sc, dxf, svg, pdf, png, jpg, jpeg, webp, gif, txt, md, csv, json. Web pages are refused: find the direct file link first. Downloaded models are not shown until you add them with set_scene.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct http(s) link to the file." },
        filename: { type: "string", description: "Optional file name with extension, e.g. 'IP67-box-datasheet.pdf' (use it when the URL has no file name)." },
        folder: { type: "string", description: "Optional project-relative folder (default 'references')." },
      },
      required: ["url"],
    },
    async run(a) {
      const r = await ctx.fetchReference(String(a.url ?? ""), a.filename ? String(a.filename) : undefined, a.folder !== undefined ? String(a.folder) : undefined);
      return text(`Saved ${r.path} (${(r.bytes / 1024).toFixed(1)} KiB, ${r.contentType || "unknown type"}, sha256 ${r.sha256.slice(0, 16)}…).`);
    },
    summarize: (a, r) => (r.isError ? "Download refused or failed" : `Downloaded ${String(a.filename ?? a.url).split("/").pop()}`),
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
    description: "Exact B-rep properties per part: volume (mm³), area (mm²), bounding box, centre of mass, validity, solid/face/edge counts; mass (g) for parts shown with a material, and the total mass and combined centre of mass.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Part ids from build/get_scene; omit for all." } } },
    async run(a) {
      need();
      const r = await ctx.worker.request("inspect", { ids: a.ids ?? null });
      return text(JSON.stringify(r.total ? { parts: r.parts, total: r.total } : r.parts, null, 1));
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
    description: "Export parts to a file inside the project: step (named, coloured parts), stl, 3mf (named meshes with colours, for slicers), glb or brep. Placements are applied.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["step", "stl", "3mf", "glb", "brep"] }, path: { type: "string", description: "Project-relative output path" }, ids: { type: "array", items: { type: "string" } },
        allow_stale: { type: "boolean", description: "Export the last good geometry of a source whose current build fails (refused by default). Say so to the user." },
      },
      required: ["format", "path"],
    },
    async run(a) {
      const p = need();
      const abs = p.abs(a.path);
      const r = await ctx.worker.request("export", { format: a.format, path: abs, ids: a.ids ?? null, allow_stale: a.allow_stale === true }, 600000);
      const notes: string[] = [];
      if (r.stale_sources?.length) notes.push(`OLD GEOMETRY: ${r.stale_sources.join(", ")} failed to build; this is its last good build, not the current file.`);
      if (r.preview) notes.push(`POSE PREVIEW: exported with ${JSON.stringify(r.preview)} instead of the file's values.`);
      return text([`Exported ${r.parts} part(s) to ${relative(p.dir, r.path)} (${(r.bytes / 1e6).toFixed(2)} MB).`, ...notes].join("\n"));
    },
  });

  // ---------------------------------------------------------------- design checks
  const ruleSchema = {
    type: "object",
    description: "kind clearance {a, b, min}; allow_contact {a, b} (intended touch/press fit/glue); envelope {parts, max:[x,y,z] (null = no limit)}; retained {part, against, directions:[[0,0,1]], within} (must be caught within that travel: e.g. a phone must not lift out); path_clear {part, against, direction, distance} (assembly/insertion path must be free: e.g. a nut slid into its pocket); interference {enabled:false} turns the implicit check off. a/b/part/parts/against are globs on part names (or ids). Add note to say why.",
    properties: { kind: { type: "string", enum: ["clearance", "allow_contact", "envelope", "retained", "path_clear", "interference"] } },
    required: ["kind"],
    additionalProperties: true,
  };

  hub.register("check_design", {
    description: `Run the project's design rules (${RULES_FILE}) and the all-pairs interference check on the current build: unintended overlaps, clearances, envelope, protected parts, retention and assembly paths. Results are nominal rigid geometry; physical tests (list_tests) take precedence.`,
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Optional: only these part ids." } } },
    async run(a) {
      need();
      const r = await ctx.checks.run(Array.isArray(a.ids) ? a.ids : undefined);
      return text(reportText(r), !!r.error);
    },
    summarize: (_a, r) => (r.content[0]?.type === "text" ? r.content[0].text.split("\n")[0].slice(0, 80) : ""),
  });

  hub.register("list_rules", {
    description: `The user's design rules in ${RULES_FILE}, with ids, and the project materials.`,
    inputSchema: { type: "object", properties: {} },
    async run() {
      const p = need();
      const d = readDesign(p);
      if (d.error) return text(`PROBLEM: ${d.error}\n${d.rules.map((r) => `- [${r.id}] ${describeRule(r)}`).join("\n")}`, !!d.unreadable);
      if (!d.rules.length) return text(`No rules yet (${RULES_FILE} is missing or empty). The interference check runs anyway with check_design.`);
      const lines = d.rules.map((r) => `- [${r.id}] ${describeRule(r)}${r.note ? ` – ${r.note}` : ""}${r.by ? ` (by ${r.by})` : ""}`);
      if (d.materials) lines.push(`Project materials: ${JSON.stringify(d.materials)}`);
      if (d.sweep) lines.push(`Default sweep: ${JSON.stringify(d.sweep)}`);
      return text(lines.join("\n"));
    },
  });

  hub.register("add_rule", {
    description: `Propose a design rule; the user confirms it in SlashCAD before it is written to ${RULES_FILE}. Use rules for requirements that must keep holding (fits, intended contacts, retention, access paths, outer size), not for one-off checks.`,
    inputSchema: { type: "object", properties: { rule: ruleSchema }, required: ["rule"] },
    async run(a) {
      const p = need();
      const rule = { ...(a.rule ?? {}), by: ctx.agentName() };
      if (rule.kind === "protected") throw new Error("protected rules are created by the user in the Checks panel");
      const ok = await ctx.confirm(`${ctx.agentName()} wants to add a design rule`, `${describeRule({ id: "", ...rule } as any)}${rule.note ? `\n\n${rule.note}` : ""}\n\nIt is saved in ${RULES_FILE} and checked after every build.`, "Add rule");
      if (!ok) return text("The user declined the rule.", true);
      const r = addRule(p, rule);
      ctx.designChanged();
      const rep = await ctx.checks.run();
      return text(`Added rule ${r.id}.\n${reportText(rep)}`);
    },
    summarize: (a, r) => (r.isError ? "Rule declined" : `Rule ${a.rule?.kind ?? ""}`),
  });

  hub.register("remove_rule", {
    description: "Remove a design rule by id; the user confirms it in SlashCAD.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"] },
    async run(a) {
      const p = need();
      const r = readDesign(p).rules.find((x) => x.id === a.id);
      if (!r) return text(`No rule ${a.id}.`, true);
      const ok = await ctx.confirm(`${ctx.agentName()} wants to remove a design rule`, `${describeRule(r)}\n\nReason: ${a.reason}`, "Remove rule");
      if (!ok) return text("The user kept the rule.", true);
      removeRule(p, String(a.id));
      ctx.designChanged();
      ctx.checks.run().catch(() => {});
      return text(`Removed rule ${a.id}.`);
    },
  });

  hub.register("sweep_check", {
    description: "Motion study: rebuild the scripts with a top-level parameter (e.g. SLIDE = 0) set to each value from..to (in memory, the file is not changed) and check every pair of parts for interference and minimum clearance at every pose, plus the design rules. Returns failing poses and the closest pairs with the pose where each is closest. Use it for sliders, hinges, cams and anything that moves.",
    inputSchema: {
      type: "object",
      properties: {
        param: { type: "string" }, from: { type: "number" }, to: { type: "number" }, step: { type: "number" },
        file: { type: "string", description: "Optional: the script that defines the parameter (default: every shown script that has it)." },
        ids: { type: "array", items: { type: "string" }, description: "Optional: only these parts (globs on names or ids)." },
        use_rules: { type: "boolean", description: "Also evaluate the design rules at every pose (default true)." },
      },
      required: ["param", "from", "to", "step"],
    },
    async run(a) {
      need();
      const r = await ctx.checks.runSweep({ param: String(a.param), from: Number(a.from), to: Number(a.to), step: Number(a.step), file: a.file, ids: a.ids, useRules: a.use_rules !== false });
      return text(sweepText(r));
    },
    summarize: (a, r) => (r.isError ? "Sweep failed" : `Sweep ${a.param}`),
  });

  hub.register("show_pose", {
    description: "Show the model in the user's view with a parameter at another value (e.g. the worst pose from sweep_check) without changing the file, or clear the preview. The user sees a banner while a pose is shown.",
    inputSchema: { type: "object", properties: { param: { type: "string" }, value: { type: "number" }, file: { type: "string" }, clear: { type: "boolean" } } },
    async run(a) {
      const p = need();
      if (a.clear) { const r = await ctx.setPreview(null); return text(`Pose preview cleared.\n${buildSummary(r, p)}`); }
      const file = a.file ?? p.info.scene.find((s) => s.endsWith(".py") && new RegExp(`^${String(a.param)}\\s*(:\\s*(int|float))?\\s*=`, "m").test(p.readText(s)));
      if (!file) return text(`No shown script defines ${a.param}.`, true);
      const r = await ctx.setPreview({ file, param: String(a.param), value: Number(a.value) });
      return text(buildSummary(r, p), r.sources.some((s) => s.error));
    },
    summarize: (a) => (a.clear ? "Pose cleared" : `Pose ${a.param} = ${a.value}`),
  });

  hub.register("printability", {
    description: "FDM printability per part in its current placed orientation (bed = lowest Z; the user can lay a face flat in the view): overhang area beyond the printer's overhang angle, flat bridges/roofs, first-layer contact, bed fit, and the overhang of the six axis orientations. Optionally slices with the user's PrusaSlicer/SuperSlicer CLI using a generic profile (support volume, time, slicer warnings). A watertight model is not proof of printability; ask for a test print of critical parts.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Part ids (default: all)." },
        slice: { type: "boolean", description: "Also run the slicer without and with support (slower, one part at a time)." },
      },
    },
    async run(a) {
      need();
      const list = await ctx.checks.printability(Array.isArray(a.ids) ? a.ids : undefined);
      if (a.slice) {
        for (const r of list.slice(0, 6)) {
          if (r.error) continue;
          for (const support of [false, true]) {
            try { await ctx.checks.slice(r.id, support); } catch (e: any) { r.hints = [...(r.hints ?? []), `slicer: ${e?.message ?? e}`]; break; }
          }
        }
      }
      const st = getSettings();
      const full = list.map((r) => ctx.checks.prints.get(r.id) ?? r);
      return text(printText(full, `bed ${st.printerBed.join(" × ")} mm, nozzle ${st.printerNozzle} mm, overhang limit ${st.overhangDeg}°, fit clearance ${st.fitClearance} mm`));
    },
    summarize: (a) => `Printability${a.slice ? " + slicer" : ""}`,
  });

  hub.register("list_tests", {
    description: `The physical test log (${TESTS_FILE}): prints, fits, assembly trials and measurements the user made, newest last. This is the primary evidence: when it contradicts a nominal CAD check, the test wins. Read it before changing a design that has been printed or assembled.`,
    inputSchema: { type: "object", properties: { last: { type: "integer", description: "Only the last N entries (default 20)." } } },
    async run(a) {
      const p = need();
      const list = readTests(p);
      if (!list.length) return text("No physical tests are logged yet. When the user reports a print or fit result in chat, offer to log it with add_test_note.");
      return text(list.slice(-(Number(a.last) || 20)).map(describeTest).join("\n\n"));
    },
  });

  hub.register("add_test_note", {
    description: `Log a physical test result the user reported (what was printed or assembled, what happened, measured values). The user confirms it in SlashCAD before it is saved in ${TESTS_FILE}. Record the user's observations faithfully; do not add your own conclusions as observations.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        result: { type: "string", enum: ["pass", "fail", "partial", "note"] },
        observations: { type: "string" },
        parts: { type: "array", items: { type: "string" }, description: "Part names involved." },
        measurements: { type: "array", items: { type: "object", properties: { what: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, nominal: { type: "number" } }, required: ["what", "value"] } },
        photos: { type: "array", items: { type: "string" }, description: "Project-relative photo paths (references/…)." },
        date: { type: "string", description: "YYYY-MM-DD (default today)." },
        revision: { type: "string" },
      },
      required: ["title", "result", "observations"],
    },
    async run(a) {
      const p = need();
      const ok = await ctx.confirm(`${ctx.agentName()} wants to log a physical test`, `${String(a.result ?? "note").toUpperCase()}: ${a.title}\n\n${String(a.observations ?? "").slice(0, 800)}`, "Save to test log");
      if (!ok) return text("The user did not save the entry.", true);
      const t = addTest(p, a, ctx.agentName());
      ctx.designChanged();
      return text(`Saved test ${t.id}.`);
    },
    summarize: (a, r) => (r.isError ? "Test note declined" : `Test: ${String(a.title ?? "").slice(0, 40)}`),
  });
}
