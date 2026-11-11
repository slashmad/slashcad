// A project is either a folder or a single model file.
//
// Folder mode: the folder's file tree, a recursive watcher and `.slashcad/` state inside it.
// Single-file mode (Open file…): only that file is shown and watched; state (cache, markers,
//   scene) lives in the app's data folder so nothing is written next to the file (e.g. Downloads).
//
// Safety: Python scripts run in the CAD worker, so a folder's scripts never run until the user
// trusts the folder. That decision is stored by the app (trust.ts, keyed by the real path), never
// in the project: a `trusted` flag in a received project.json is ignored. New folders get no
// scripts in the scene unless they are recognisable CAD scripts and the user agrees.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { FileDiff, FileNode, ProjectInfo } from "../shared/types";
import { makeDiff } from "./diff";
import { isTrusted, setTrusted as storeTrust } from "./trust";

const IGNORE = new Set([".git", ".slashcad", ".slashmad", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "release"]);
export const CAD_EXT = [".py", ".step", ".stp", ".brep", ".sc"];
const TEXT_EXT = [".py", ".md", ".txt", ".json", ".toml", ".yaml", ".yml"];
const MAX_TEXT = 2_000_000;
const MAX_TREE_NODES = 4000; // large folders (Downloads, home) must not stall the app
const MAX_TREE_DEPTH = 6;
const MAX_SNAPSHOT_FILES = 400;
const CAD_SCRIPT_RE = /^\s*(from|import)\s+(build123d|cadquery|slashcad|slashmad|ocp_vscode)\b/m;

export interface ProjectOptions {
  /** Absolute path of the single model file (single-file mode). */
  singleFile?: string;
  /** Where single-file state is kept (the app's userData). */
  stateRoot?: string;
  /** Trust scripts without asking (projects the app created itself, test hooks). */
  trusted?: boolean;
}

export function isCadScript(abs: string): boolean {
  try { return CAD_SCRIPT_RE.test(readFileSync(abs, "utf8").slice(0, 200_000)); } catch { return false; }
}

export class Project extends EventEmitter {
  readonly dir: string;
  readonly singleFile: string | null; // project-relative name of the single file
  private readonly state: string;
  info: ProjectInfo;
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private snapshots = new Map<string, string>(); // last seen text, for diffs
  private diffs: FileDiff[] = [];
  truncated = false;

  constructor(path: string, opts: ProjectOptions = {}) {
    super();
    if (opts.singleFile) {
      this.dir = dirname(opts.singleFile);
      this.singleFile = basename(opts.singleFile);
      const id = createHash("sha1").update(opts.singleFile).digest("hex").slice(0, 16);
      this.state = join(opts.stateRoot ?? this.dir, "single-files", id);
    } else {
      this.dir = path;
      this.singleFile = null;
      this.state = join(this.dir, ".slashcad");
      // Folders opened before the rename to SlashCAD keep their state in .slashmad/.
      const legacy = join(this.dir, ".slashmad");
      if (!existsSync(this.state) && existsSync(legacy)) {
        try { renameSync(legacy, this.state); } catch { /* read-only folder: start fresh */ }
      }
    }
    this.info = this.loadInfo(opts.trusted);
    this.snapshotTexts();
  }

  get stateDir(): string { return this.state; }
  get cacheDir(): string { return join(this.stateDir, "cache"); }

  private loadInfo(forceTrusted?: boolean): ProjectInfo {
    mkdirSync(this.stateDir, { recursive: true });
    if (!this.singleFile) {
      const gi = join(this.stateDir, ".gitignore");
      if (!existsSync(gi)) writeFileSync(gi, "# SlashCAD: cache and local state\n*\n");
    }
    const pj = join(this.stateDir, "project.json");
    let scene: string[] | null = null;
    let quality: ProjectInfo["quality"] = "normal";
    let trusted = false;
    let isNew = true;
    let placements: Record<string, number[]> = {};
    try {
      const j = JSON.parse(readFileSync(pj, "utf8"));
      isNew = false;
      scene = Array.isArray(j.scene) ? j.scene : null;
      if (j.quality) quality = j.quality;
      if (j.placements && typeof j.placements === "object") {
        for (const [id, m] of Object.entries(j.placements)) {
          if (Array.isArray(m) && m.length === 16 && m.every((x) => typeof x === "number" && Number.isFinite(x))) placements[id] = m as number[];
        }
      }
    } catch { /* new project */ }
    if (this.singleFile) scene = [this.singleFile];
    if (!scene) scene = this.defaultScene();
    // Execution trust comes only from the app's own store (or an app-created project).
    trusted = isTrusted(this.trustPath);
    if (forceTrusted) { trusted = true; storeTrust(this.trustPath, true); }
    return {
      dir: this.dir, name: this.singleFile ?? basename(this.dir), scene, quality, trusted, isNew,
      singleFile: this.singleFile ?? undefined, scripts: this.scriptsIn(scene), placements,
    };
  }

  /** New folder: main.py if it is a CAD script, else other root-level CAD scripts. Never arbitrary .py. */
  private defaultScene(): string[] {
    let root: string[] = [];
    try { root = readdirSync(this.dir); } catch { return []; }
    if (root.includes("main.py") && isCadScript(join(this.dir, "main.py"))) return ["main.py"];
    return root.filter((f) => f.endsWith(".py") && isCadScript(join(this.dir, f))).slice(0, 10);
  }

  private scriptsIn(scene: string[]): string[] {
    return scene.filter((s) => s.toLowerCase().endsWith(".py"));
  }

  /** Scene entries the worker may build now: scripts only when trusted. */
  buildableScene(): string[] {
    return this.info.scene.filter((s) => this.info.trusted || !s.toLowerCase().endsWith(".py"));
  }

  /** What the trust decision applies to: the folder, or the single opened file. */
  get trustPath(): string {
    return this.singleFile ? join(this.dir, this.singleFile) : this.dir;
  }

  setTrusted(v: boolean): void {
    storeTrust(this.trustPath, v);
    this.info.trusted = v;
    this.saveInfo();
  }

  saveInfo(): void {
    this.info.scripts = this.scriptsIn(this.info.scene);
    this.info.isNew = false;
    writeFileSync(join(this.stateDir, "project.json"), JSON.stringify({ scene: this.info.scene, quality: this.info.quality, placements: this.info.placements ?? {} }, null, 2));
    this.emit("info", this.info);
  }

  setScene(scene: string[]): void {
    const before = [...this.info.scene];
    this.info.scene = [...new Set(scene)].filter((s) => existsSync(join(this.dir, s)));
    this.saveInfo();
    if (before.join("\n") !== this.info.scene.join("\n")) this.emit("scene-changed", { before, after: [...this.info.scene] });
  }

  /** Set or clear (null) the user placement of a part. */
  setPlacement(id: string, matrix: number[] | null): void {
    const all = { ...(this.info.placements ?? {}) };
    const before = all[id] ?? null;
    if (matrix) all[id] = matrix; else delete all[id];
    this.info.placements = all;
    this.saveInfo();
    this.emit("placement-changed", { id, before, after: matrix });
  }

  /** Text the watcher compares against, so changes the app makes itself (undo) are not recorded as edits. */
  setSnapshot(rel: string, text: string | null): void {
    if (text === null) this.snapshots.delete(rel); else this.snapshots.set(rel, text);
  }

  isTextFile(rel: string): boolean { return this.isText(rel); }

  setQuality(q: ProjectInfo["quality"]): void {
    this.info.quality = q;
    this.saveInfo();
  }

  tree(): FileNode {
    if (this.singleFile) {
      let size: number | undefined;
      try { size = statSync(join(this.dir, this.singleFile)).size; } catch { /* removed */ }
      return { name: basename(this.dir), path: "", dir: true, children: [{ name: this.singleFile, path: this.singleFile, dir: false, size }] };
    }
    let count = 0;
    this.truncated = false;
    const walk = (abs: string, depth: number): FileNode[] => {
      if (depth > MAX_TREE_DEPTH) return [];
      let entries: string[] = [];
      try { entries = readdirSync(abs); } catch { return []; }
      const nodes: FileNode[] = [];
      for (const name of entries.sort((a, b) => a.localeCompare(b))) {
        if (count >= MAX_TREE_NODES) { this.truncated = true; break; }
        if (IGNORE.has(name) || (name.startsWith(".") && name !== ".mcp.json")) continue;
        const p = join(abs, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        count++;
        const rel = relative(this.dir, p).split(sep).join("/");
        if (st.isDirectory()) nodes.push({ name, path: rel, dir: true, children: walk(p, depth + 1) });
        else nodes.push({ name, path: rel, dir: false, size: st.size });
      }
      return nodes.sort((a, b) => Number(b.dir) - Number(a.dir));
    };
    return { name: basename(this.dir), path: "", dir: true, children: walk(this.dir, 0) };
  }

  readText(rel: string): string {
    const p = this.abs(rel);
    if (statSync(p).size > MAX_TEXT) throw new Error("the file is too large to show");
    return readFileSync(p, "utf8");
  }

  abs(rel: string): string {
    const p = join(this.dir, rel);
    if (relative(this.dir, p).startsWith("..")) throw new Error("the path is outside the project");
    return p;
  }

  recentDiffs(): FileDiff[] { return this.diffs.slice(-30); }

  private isText(rel: string): boolean { return TEXT_EXT.some((e) => rel.toLowerCase().endsWith(e)); }

  private inScope(rel: string): boolean {
    return !this.singleFile || rel === this.singleFile;
  }

  private snapshotTexts(): void {
    let n = 0;
    const walk = (node: FileNode) => {
      for (const c of node.children ?? []) {
        if (n >= MAX_SNAPSHOT_FILES) return;
        if (c.dir) walk(c);
        else if (this.isText(c.path) && (c.size ?? 0) < MAX_TEXT) {
          try { this.snapshots.set(c.path, readFileSync(this.abs(c.path), "utf8")); n++; } catch { /* ignore */ }
        }
      }
    };
    walk(this.tree());
  }

  startWatching(): void {
    if (this.watcher) return;
    // Single file: watch its folder non-recursively (editors save by rename) and filter by name.
    this.watcher = watch(this.dir, { recursive: !this.singleFile }, (_ev, file) => {
      if (!file) return;
      const rel = file.toString().split(sep).join("/");
      if (!this.inScope(rel)) return;
      if (rel.split("/").some((seg) => IGNORE.has(seg))) return;
      this.pending.add(rel);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 120);
    });
    this.watcher.on("error", () => { /* folder removed or not watchable */ });
  }

  private flush(): void {
    const changed = [...this.pending];
    this.pending.clear();
    const diffs: FileDiff[] = [];
    const edits: { path: string; before: string | null; after: string }[] = [];
    for (const rel of changed) {
      if (!this.isText(rel)) continue;
      let now: string | null = null;
      try { now = statSync(this.abs(rel)).size < MAX_TEXT ? readFileSync(this.abs(rel), "utf8") : null; } catch { now = null; }
      const known = this.snapshots.has(rel);
      const before = this.snapshots.get(rel) ?? "";
      if (now === null) { this.snapshots.delete(rel); continue; }
      if (now === before) continue;
      this.snapshots.set(rel, now);
      edits.push({ path: rel, before: known ? before : null, after: now });
      const d = makeDiff(rel, before, now);
      diffs.push(d);
      this.diffs.push(d);
    }
    if (this.diffs.length > 200) this.diffs.splice(0, this.diffs.length - 200);
    this.emit("changed", { files: changed, diffs, edits });
  }

  touchesScene(files: string[]): boolean {
    // Any .py edit may be imported by a scene script; STEP/BREP/SC only if shown.
    return files.some((f) => (f.endsWith(".py") && this.info.scene.some((s) => s.endsWith(".py"))) || this.info.scene.includes(f));
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }
}
