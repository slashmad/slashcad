// Electron main process: window, display backend, project, CAD worker, agents, MCP hub, IPC.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentEvent, AgentKind, PermissionDecision, PosePreview, SnapshotRequest } from "../shared/types";
import { AgentSession } from "./agents/base";
import { claudeAuthStatus, claudeLogin, codexAuthStatus, codexLogin, writeLoginInput } from "./agents/auth";
import { pickBinary } from "./agents/binaries";
import { ClaudeSession, listClaudeSessions, loadClaudeHistory } from "./agents/claude";
import { CodexSession, listCodexSessions } from "./agents/codex";
import { Annotations } from "./annotations";
import { Builder } from "./builder";
import { CadWorker } from "./cadWorker";
import { DesignChecks, findSlicer } from "./checks";
import { addRule, addTest, readDesign, readTests, removeRule, removeTest, RULES_FILE, setSweep, TESTS_FILE, updateTest } from "./design";
import { integrateDesktop } from "./desktopIntegration";
import { downloadReference } from "./download";
import { History, type Op } from "./history";
import { McpHub } from "./mcpHub";
import { CAD_EXT, isCadScript, Project, type ProjectOptions } from "./project";
import { getSettings, rememberProject, setSettings } from "./settings";
import { readParams, writeParam } from "./params";
import { launchSolidcraft, SOLIDCRAFT_INSTRUCTIONS, solidcraftInfo, solidcraftMcp } from "./solidcraft";
import { registerTools } from "./tools";

// ---------------------------------------------------------------- portable mode (Windows)
// The portable exe (electron-builder "portable") sets PORTABLE_EXECUTABLE_DIR: keep settings,
// the MCP token and caches next to the exe instead of in %APPDATA%. Must run before anything
// reads userData.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath("userData", join(process.env.PORTABLE_EXECUTABLE_DIR, "SlashCAD-data"));
}
// The app was called "Slashmad CAD Editor" up to 0.2.8: move its settings, recent projects,
// single-file state and MCP token to the new folder once.
if (!process.env.SLASHCAD_USER_DATA) {
  const data = app.getPath("userData");
  const legacy = process.env.PORTABLE_EXECUTABLE_DIR
    ? join(process.env.PORTABLE_EXECUTABLE_DIR, "SlashmadCADEditor-data")
    : join(app.getPath("appData"), "Slashmad CAD Editor");
  // Electron creates the new folder (Crashpad) before this runs, so move entries one by one.
  if (existsSync(legacy) && !existsSync(join(data, "settings.json"))) {
    try {
      mkdirSync(data, { recursive: true });
      for (const name of readdirSync(legacy)) {
        if (!existsSync(join(data, name))) renameSync(join(legacy, name), join(data, name));
      }
      rmSync(legacy, { recursive: true, force: true }); // only leftovers the new folder already has
    } catch { /* in use or read-only: start fresh */ }
  }
}
// Test/second-profile hook: a separate data folder gets its own single-instance lock, settings
// and MCP socket, so it never disturbs a running instance of the user.
if (process.env.SLASHCAD_USER_DATA) app.setPath("userData", process.env.SLASHCAD_USER_DATA);

// ---------------------------------------------------------------- display backend (Linux)
// Wayland first (user decision 2026-11-08), X11/XWayland as fallback.
const ozone = app.commandLine.getSwitchValue("ozone-platform");
const ozoneHint = app.commandLine.getSwitchValue("ozone-platform-hint");
const effectiveOzone = ozone || (ozoneHint === "auto" && process.env.WAYLAND_DISPLAY ? "wayland" : ozoneHint === "wayland" ? "wayland" : "x11");

function relaunchWith(platform: string): void {
  process.env.SLASHCAD_RELAUNCHED = "1";
  const args = [...process.argv.slice(1).filter((a) => !a.startsWith("--ozone-platform")), `--ozone-platform=${platform}`];
  // Inside an AppImage the running binary lives in a temporary mount; relaunch the AppImage itself.
  app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args } : { args });
  app.exit(0);
}

if (process.platform === "linux" && !process.env.SLASHCAD_RELAUNCHED) {
  const pref = getSettings().displayBackend;
  const want = pref === "auto" ? (process.env.WAYLAND_DISPLAY ? "wayland" : "x11") : pref;
  if (effectiveOzone !== want) relaunchWith(want);
}
const displayBackend = process.platform === "linux" ? effectiveOzone : process.platform;
let gpuCrashes = 0;
app.on("child-process-gone", (_e, d) => {
  if (d.type !== "GPU" || d.reason === "clean-exit") return;
  gpuCrashes++;
  if (process.platform === "linux" && displayBackend === "wayland" && gpuCrashes >= 2) {
    setSettings({ displayBackend: "x11" });
    relaunchWith("x11");
  }
});

// A second instance hands its arguments to the first one and exits without touching shared
// state (socket, worker, settings).
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

// ---------------------------------------------------------------- state
let win: BrowserWindow | null = null;
let project: Project | null = null;
let annotations: Annotations | null = null;
let history: History | null = null;
const worker = new CadWorker();
const builder = new Builder(worker, () => project);
const checks = new DesignChecks(worker, builder, () => project);
const hub = new McpHub(app.getPath("userData"), process.env.SLASHCAD_USER_DATA ? "test" : "");
let agent: AgentSession | null = null;
const snapshotWaiters = new Map<string, { resolve: (u: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

// A closed stdout/stderr (a terminal or pipe that went away) must never become an error dialog:
// console.log/error would otherwise throw EPIPE as an uncaught exception in the main process.
for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", () => {});

const send = (channel: string, ...args: unknown[]) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };

function resourcePath(...p: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p);
}

function mcpScript(): string {
  const p = join(app.getAppPath(), "dist", "mcp", "server.js");
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

function mcpLaunch() {
  return {
    command: process.execPath,
    args: [mcpScript()],
    env: { ELECTRON_RUN_AS_NODE: "1", SLASHCAD_IPC: hub.address, SLASHCAD_TOKEN: hub.token },
  };
}

// ---------------------------------------------------------------- project
/** Ask before any Python from a folder or file runs in the CAD worker. Returns the decision. */
async function confirmTrust(p: Project): Promise<boolean> {
  const scripts = p.info.scene.filter((s) => s.toLowerCase().endsWith(".py"));
  if (!scripts.length || p.info.trusted) return true;
  const single = !!p.singleFile;
  const r = await dialog.showMessageBox(win!, {
    type: "question",
    buttons: single ? ["Run it", "Don't run"] : ["Trust and build", "Open without running scripts"],
    defaultId: 1, cancelId: 1,
    title: "Run Python scripts?",
    message: single ? `Run ${scripts[0]} to show its geometry?` : `This folder has ${scripts.length} CAD script(s): ${scripts.slice(0, 6).join(", ")}${scripts.length > 6 ? " …" : ""}`,
    detail: "Building a script runs its Python code on this computer. Only continue if you trust the files.",
  });
  const ok = r.response === 0;
  p.setTrusted(ok);
  return ok;
}

/** Open a folder as a project, or a single model file (STEP, SC, BREP, PY). */
async function openPath(path: string, opts: ProjectOptions = {}): Promise<void> {
  let isFile = false;
  try { isFile = statSync(path).isFile(); } catch { return; }
  if (isFile && !CAD_EXT.some((e) => path.toLowerCase().endsWith(e))) {
    await dialog.showMessageBox(win!, { type: "warning", message: "Unsupported file type", detail: `Open a .step, .stp, .sc, .brep or .py file, or a folder. (${basename(path)})` });
    return;
  }
  if (isFile && path.toLowerCase().endsWith(".py") && !isCadScript(path)) {
    const r = await dialog.showMessageBox(win!, { type: "warning", buttons: ["Open anyway", "Cancel"], defaultId: 1, cancelId: 1,
      message: `${basename(path)} does not import build123d or CadQuery.`, detail: "It does not look like a CAD script. Opening it will ask before running it." });
    if (r.response !== 0) return;
  }
  openProject(path, isFile ? { ...opts, singleFile: path, stateRoot: app.getPath("userData") } : opts);
  if (project) {
    const trusted = await confirmTrust(project);
    if (!trusted) send("project:info", project.info);
    builder.request("opened").catch(() => {});
  }
}

// ---------------------------------------------------------------- files: import, delete, placement
const MODEL_EXT = [".step", ".stp", ".brep", ".sc"];

/** Yes/no question; test profiles (SLASHCAD_USER_DATA + SLASHCAD_TEST_AUTOCONFIRM) answer yes. */
async function confirmBox(opts: Electron.MessageBoxOptions): Promise<boolean> {
  if (process.env.SLASHCAD_USER_DATA && process.env.SLASHCAD_TEST_AUTOCONFIRM) return true;
  return (await dialog.showMessageBox(win!, opts)).response === 0;
}

/** A project-relative path that does not exist yet: "name.ext", "name (2).ext", … */
function freeName(p: Project, rel: string): string {
  if (!existsSync(p.abs(rel))) return rel;
  const ext = extname(rel), stem = rel.slice(0, rel.length - ext.length);
  for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!existsSync(p.abs(c))) return c; }
}

/** Default destination: models and scripts in the project root, everything else in references/. */
function importFolderFor(name: string): string {
  const lower = name.toLowerCase();
  return MODEL_EXT.some((e) => lower.endsWith(e)) || lower.endsWith(".py") ? "" : "references";
}

function needProject(): Project {
  if (!project) throw new Error("No project is open.");
  return project;
}

function needFolderProject(): Project {
  if (!project) throw new Error("No project is open.");
  if (project.singleFile) throw new Error("Only one file is open. Click \"Make project\" first to import or delete files.");
  return project;
}

/** Copy files or folders into the project (one undo step). Models are added to the scene. */
function importPaths(paths: string[], destDir?: string): string[] {
  const p = needFolderProject();
  const h = history!;
  const done: string[] = [];
  h.group(`import ${paths.length} item(s)`, (ops: Op[]) => {
    for (const src of paths) {
      const name = basename(src);
      const folder = destDir ?? importFolderFor(name);
      const rel = freeName(p, folder ? `${folder}/${name}` : name);
      const abs = p.abs(rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (statSync(src).isDirectory()) cpSync(src, abs, { recursive: true }); else copyFileSync(src, abs);
      ops.push({ kind: "file", path: rel, stash: h.stashPath(rel), present: true });
      done.push(rel);
    }
    const models = done.filter((r) => MODEL_EXT.some((e) => r.toLowerCase().endsWith(e)));
    if (models.length) p.setScene([...p.info.scene, ...models]);
  });
  if (done.some((r) => MODEL_EXT.some((e) => r.toLowerCase().endsWith(e)))) builder.request("scene").catch(() => {});
  return done;
}

/** Move files to .slashcad/trash after a confirmation (one undo step). */
async function deletePaths(rels: string[]): Promise<number> {
  const p = needFolderProject();
  const list = [...new Set(rels)].filter((r) => r && !r.split("/").some((seg) => seg === ".slashcad" || seg === ".git") && existsSync(p.abs(r)));
  // Drop entries inside a folder that is deleted too.
  const top = list.filter((r) => !list.some((o) => o !== r && r.startsWith(o + "/")));
  if (!top.length) return 0;
  const yes = await confirmBox({
    type: "question", buttons: ["Delete", "Cancel"], defaultId: 0, cancelId: 1,
    message: top.length === 1 ? `Delete ${top[0]}?` : `Delete ${top.length} items?`,
    detail: (top.length > 1 ? top.slice(0, 12).join("\n") + (top.length > 12 ? "\n…" : "") + "\n\n" : "") + "Ctrl+Z restores them.",
  });
  if (!yes) return 0;
  const h = history!;
  h.group(top.length === 1 ? `delete ${basename(top[0])}` : `delete ${top.length} items`, (ops: Op[]) => {
    for (const rel of top) {
      const stash = h.stashPath(rel);
      mkdirSync(dirname(stash), { recursive: true });
      p.setSnapshot(rel, null);
      renameSync(p.abs(rel), stash);
      ops.push({ kind: "file", path: rel, stash, present: false });
    }
    const gone = (s: string) => top.some((t) => s === t || s.startsWith(t + "/"));
    if (p.info.scene.some(gone)) p.setScene(p.info.scene.filter((s) => !gone(s)));
  });
  builder.request("scene").catch(() => {});
  return top.length;
}

function pushPlacements(): void {
  if (!project) return;
  worker.request("set_placements", { placements: project.info.placements ?? {} }).catch(() => {});
}

/** fetch_reference: ask the user, download into the project, record it for undo. */
async function fetchReference(url: string, filename: string | undefined, folder: string | undefined, agentName: string): Promise<{ path: string; bytes: number; sha256: string; contentType: string }> {
  const p = needFolderProject();
  const dir = (folder ?? "references").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (dir.split("/").some((seg) => seg === ".." || seg === ".slashcad" || seg === ".git")) throw new Error("invalid folder");
  const ok = await confirmBox({
    type: "question", buttons: ["Download", "Cancel"], defaultId: 0, cancelId: 1,
    message: `${agentName} wants to download a file into the project`,
    detail: `${url}\n\n→ ${dir || "(project folder)"}/${filename ?? "(name from the download)"}\n\nOnly data files are accepted (STEP, STL, PDF, images …); they are never run.`,
  });
  if (!ok) throw new Error("The user declined the download.");
  const d = await downloadReference(url, filename);
  const rel = freeName(p, dir ? `${dir}/${d.name}` : d.name);
  const abs = p.abs(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, d.data);
  history?.push(`download ${d.name}`, [{ kind: "file", path: rel, stash: history.stashPath(rel), present: true }]);
  return { path: rel, bytes: d.data.length, sha256: d.sha256, contentType: d.contentType };
}

function openProject(dir: string, opts: ProjectOptions = {}): void {
  project?.dispose();
  history?.removeAllListeners();
  stopAgent();
  builder.reset();
  checks.reset();
  project = new Project(dir, opts);
  history = new History(project);
  history.on("state", (st) => send("history:state", st));
  history.on("applied", (a: { scene: boolean }) => { if (a.scene) builder.request("scene").catch(() => {}); });
  project.on("placement-changed", () => { pushPlacements(); checks.invalidatePrints(); });
  annotations?.removeAllListeners();
  annotations = new Annotations(project.stateDir);
  annotations.on("changed", (list) => send("annotations:changed", list));
  rememberProject(opts.singleFile ?? dir);
  project.on("changed", ({ files, diffs }) => {
    send("project:changed", { files, diffs, tree: project!.tree() });
    if (files.some((f: string) => f.endsWith(".py"))) send("params:changed", readParams(project!));
    if (project!.touchesScene(files)) builder.request("file").catch(() => {});
    // The user's rules and test log: hand edits show up at once and the rules are re-checked.
    if (files.includes(RULES_FILE) || files.includes(TESTS_FILE)) designChanged(files.includes(RULES_FILE));
  });
  project.on("info", (info) => { send("project:info", info); send("params:changed", readParams(project!)); });
  project.startWatching();
  send("project:opened", { info: project.info, tree: project.tree() });
  send("history:state", history.state());
  send("annotations:changed", annotations.list());
  send("params:changed", readParams(project));
}

/** Rules or test log changed (any writer): refresh the panels; re-check rules on the current build. */
function designChanged(rules = true): void {
  if (!project) return;
  send("design:changed", readDesign(project));
  send("tests:changed", readTests(project));
  if (rules && builder.last) checks.run().catch(() => {});
}

/** Pose preview: show a parameter value without writing the file (motion study). */
function setPreview(p: PosePreview | null) {
  builder.preview = p;
  return builder.request(p ? `preview ${p.param}=${p.value}` : "preview cleared");
}

function createProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const main = join(dir, "main.py");
  if (!existsSync(main)) copyFileSync(resourcePath("examples", "demo", "main.py"), main);
  void openPath(dir, { trusted: true });
}

/** Single-file mode: keep agents out of the surrounding folder (often Downloads or home). */
function singleFileInstructions(p: Project): string {
  return `

IMPORTANT – single-file mode: the user opened one model file, ${join(p.dir, p.singleFile!)}, without a project. Its folder may be a general folder such as Downloads: do not list, search or change other files there, and never search the home folder. You can inspect, measure and render this model with the CAD tools. To add or change geometry (new parts that fit this model, holes, mounts …), ask the user to click "Make project" in the top bar of SlashCAD: it creates a project folder with a copy of the model and a main.py where new parts go, and the session restarts there.`;
}

/** Turn the open single file into a project folder: copy of the model + main.py for new parts. */
async function makeProjectFromFile(): Promise<boolean> {
  if (!project?.singleFile) return false;
  const src = join(project.dir, project.singleFile);
  const stem = basename(project.singleFile).replace(/\.[^.]+$/, "");
  const base = join(app.getPath("home"), "SlashCAD Projects");
  mkdirSync(base, { recursive: true });
  const r = await dialog.showOpenDialog(win!, {
    title: "Choose or create the project folder", defaultPath: join(base, stem), buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  });
  if (r.canceled || !r.filePaths[0]) return false;
  const dir = r.filePaths[0];
  mkdirSync(dir, { recursive: true });
  const model = basename(project.singleFile);
  if (!existsSync(join(dir, model))) copyFileSync(src, join(dir, model));
  const main = join(dir, "main.py");
  if (!existsSync(main) && model.toLowerCase().match(/\.(step|stp|sc|brep)$/)) {
    writeFileSync(main, `"""New parts for ${model}. The model itself is shown as its own part; edit and save to rebuild."""
from build123d import *  # noqa: F403
from slashcad import show, load_step

base = load_step(${JSON.stringify(model)})  # cached reference geometry: use it for positions and fits
bb = base.bounding_box()
print("reference size (mm):", round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2))

# Add new parts here and show each one, for example:
# with BuildPart() as button:
#     with Locations((bb.center().X, bb.min.Y - 3, bb.center().Z)):
#         Cylinder(radius=3, height=6, rotation=(90, 0, 0))
# show(button, name="button", color="orange")
`);
  }
  mkdirSync(join(dir, ".slashcad"), { recursive: true });
  const scene = model.toLowerCase().endsWith(".py") ? [model] : [model, "main.py"];
  writeFileSync(join(dir, ".slashcad", "project.json"), JSON.stringify({ scene, quality: project.info.quality }, null, 2));
  await openPath(dir, { trusted: true });
  return true;
}

// ---------------------------------------------------------------- agents
function stopAgent(): void {
  agent?.removeAllListeners();
  agent?.stop();
  agent = null;
}

async function startAgent(kind: AgentKind, resumeId?: string): Promise<{ ok: boolean; error?: string; binary?: string; version?: string }> {
  if (!project) return { ok: false, error: "Open a project first." };
  stopAgent();
  const s = getSettings();
  const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
  if (!bin) {
    return { ok: false, error: kind === "claude"
      ? "Claude Code was not found. Install the Claude Code VS Code extension or CLI, or set its path in Settings > Agents."
      : "Codex was not found. Install the ChatGPT/Codex VS Code extension or the codex CLI, or set its path in Settings > Agents." };
  }
  setSettings({ lastAgent: kind });
  const a: AgentSession = kind === "claude" ? new ClaudeSession() : new CodexSession();
  agent = a;
  a.on("event", (ev: AgentEvent) => { if (agent === a) send("agent:event", kind, ev); });
  send("agent:event", kind, { type: "history-reset" } satisfies AgentEvent);
  if (resumeId && kind === "claude") for (const ev of loadClaudeHistory(project.dir, resumeId)) send("agent:event", kind, ev);
  try {
    const sc = solidcraftMcp(project.dir);
    await a.start({
      cwd: project.dir, resumeId, mcp: mcpLaunch(), binary: bin.path, model: kind === "claude" ? s.claudeModel : s.codexModel,
      extraMcp: sc ? { solidcraft: sc } : undefined,
      extraInstructions: (sc ? SOLIDCRAFT_INSTRUCTIONS : "") + (project.singleFile ? singleFileInstructions(project) : "") || undefined,
    });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  return { ok: true, binary: bin.path, version: bin.version };
}

// ---------------------------------------------------------------- window
function createWindow(): void {
  win = new BrowserWindow({
    width: 1680, height: 1020, minWidth: 1000, minHeight: 640, backgroundColor: "#16181d", show: false,
    title: "SlashCAD",
    icon: join(__dirname, "..", "renderer", "icon-256.png"), // Linux/Windows window icon (packages also set it)
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false,
      spellcheck: false, // Chromium would download dictionaries from Google; the app makes no network requests of its own
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"));
  win.on("closed", () => { win = null; });
  if (process.env.SLASHCAD_DEBUG) {
    win.webContents.on("console-message", (e: any) => console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  }
}

// ---------------------------------------------------------------- IPC
function registerIpc(): void {
  ipcMain.handle("app:info", () => ({
    displayBackend, platform: process.platform, version: app.getVersion(), settings: getSettings(),
    project: project ? { info: project.info, tree: project.tree() } : null,
    build: builder.last, buildState: builder.state,
    claude: pickBinary("claude", getSettings().claudePath), codex: pickBinary("codex", getSettings().codexPath),
    solidcraft: solidcraftInfo(),
  }));
  ipcMain.handle("settings:set", (_e, patch) => {
    const r = setSettings(patch);
    if ("solidcraftCliPath" in patch || "solidcraftAppPath" in patch) solidcraftInfo(true);
    checks.invalidatePrints(); // printer settings are part of each printability result
    return r;
  });
  ipcMain.handle("solidcraft:info", () => solidcraftInfo());
  ipcMain.handle("solidcraft:open", (_e, rel?: string) => launchSolidcraft(rel && project ? project.abs(rel) : undefined));

  ipcMain.handle("project:openDialog", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Open CAD project (folder)" });
    if (r.canceled || !r.filePaths[0]) return false;
    await openPath(r.filePaths[0]);
    return true;
  });
  ipcMain.handle("project:newDialog", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Choose or create an empty folder for a new project" });
    if (r.canceled || !r.filePaths[0]) return false;
    createProject(r.filePaths[0]);
    return true;
  });
  ipcMain.handle("project:open", async (_e, path: string) => { if (existsSync(path)) { await openPath(path); return true; } return false; });
  ipcMain.handle("project:openFileDialog", async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile"], title: "Open CAD model",
      filters: [{ name: "CAD models", extensions: ["step", "stp", "sc", "brep", "py"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths[0]) return false;
    await openPath(r.filePaths[0]);
    return true;
  });
  ipcMain.handle("project:makeProject", () => makeProjectFromFile());
  ipcMain.handle("project:trust", async () => {
    if (!project) return false;
    project.setTrusted(true);
    await builder.request("scene");
    return true;
  });
  ipcMain.handle("project:readText", (_e, rel: string) => project?.readText(rel) ?? "");
  ipcMain.handle("project:diffs", () => project?.recentDiffs() ?? []);
  ipcMain.handle("project:setScene", async (_e, scene: string[]) => {
    if (!project) return null;
    project.setScene(scene);
    if (!project.info.trusted && project.info.scene.some((s) => s.endsWith(".py"))) await confirmTrust(project);
    return builder.request("scene");
  });
  ipcMain.handle("project:setQuality", (_e, q) => { project?.setQuality(q); return builder.request("quality"); });
  ipcMain.handle("project:reveal", (_e, rel: string) => project && shell.showItemInFolder(project.abs(rel)));
  ipcMain.handle("project:installMcp", () => {
    // Writes .mcp.json so Claude Code inside VS Code can use the CAD tools while this app runs.
    if (!project) return false;
    // No token or socket path in the file (projects get committed): the server derives both.
    const cfg = { mcpServers: { "slashcad": { type: "stdio", command: process.execPath, args: [mcpScript()], env: { ELECTRON_RUN_AS_NODE: "1" } } } };
    writeFileSync(join(project.dir, ".mcp.json"), JSON.stringify(cfg, null, 2));
    return true;
  });

  ipcMain.handle("history:undo", () => history?.undo() ?? null);
  ipcMain.handle("history:redo", () => history?.redo() ?? null);
  ipcMain.handle("history:state", () => history?.state() ?? { undo: null, redo: null });
  ipcMain.handle("project:import", (_e, paths: string[], destDir?: string) => importPaths(paths, destDir));
  ipcMain.handle("project:importDialog", async (_e, destDir?: string) => {
    needFolderProject();
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], title: "Import files into the project" });
    if (r.canceled || !r.filePaths.length) return [];
    return importPaths(r.filePaths, destDir);
  });
  ipcMain.handle("project:delete", (_e, rels: string[]) => deletePaths(rels));
  ipcMain.handle("placement:set", (_e, id: string, matrix: number[] | null) => {
    if (!project) return false;
    project.setPlacement(id, matrix);
    return true;
  });

  ipcMain.handle("cad:build", () => builder.request("manual"));
  ipcMain.handle("cad:restartWorker", () => { worker.restart(); return true; });
  ipcMain.handle("cad:mesh", (_e, path: string) => {
    if (!project) throw new Error("no project");
    const abs = resolve(path);
    if (relative(project.cacheDir, abs).startsWith("..")) throw new Error("invalid path");
    return readFileSync(abs);
  });
  ipcMain.handle("cad:faceInfo", (_e, id: string, face: number) => worker.request("face_info", { id, face }, 20000));
  ipcMain.handle("annotations:list", () => annotations?.list() ?? []);
  ipcMain.handle("annotations:add", (_e, a) => annotations?.add(a) ?? null);
  ipcMain.handle("annotations:update", (_e, id: string, patch) => annotations?.update(id, patch) ?? null);
  ipcMain.handle("annotations:remove", (_e, id: string) => annotations?.remove(id));
  ipcMain.handle("annotations:clearDone", () => annotations?.clearDone());
  ipcMain.handle("params:list", () => (project ? readParams(project) : []));
  ipcMain.handle("params:set", (_e, file: string, line: number, name: string, value: number) => { if (project) writeParam(project, file, line, name, value); return true; });
  ipcMain.handle("cad:inspect", (_e, ids?: string[]) => worker.request("inspect", { ids: ids ?? null }));
  ipcMain.handle("cad:export", async (_e, format: string, ids?: string[]) => {
    if (!project) return null;
    const pv = builder.preview;
    if (pv && !(await confirmBox({ type: "question", buttons: ["Export the preview", "Cancel"], defaultId: 1, cancelId: 1,
      message: `The view shows a preview: ${pv.param} = ${pv.value}`, detail: `The file says otherwise (${pv.file}). Export the previewed pose anyway?` }))) return null;
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(project.dir, `export.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (r.canceled || !r.filePath) return null;
    return worker.request("export", { format, path: r.filePath, ids: ids ?? null }, 600000);
  });
  ipcMain.handle("checks:report", () => checks.report);
  ipcMain.handle("checks:sweep", () => checks.sweep);
  ipcMain.handle("checks:prints", () => Array.from(checks.prints.values()));
  ipcMain.handle("checks:run", (_e, ids?: string[]) => checks.run(ids));
  ipcMain.handle("checks:sweep:run", (_e, opts) => checks.runSweep(opts));
  ipcMain.handle("checks:printability", (_e, ids?: string[]) => checks.printability(ids));
  ipcMain.handle("checks:slice", (_e, id: string, support: boolean) => checks.slice(id, support));
  ipcMain.handle("checks:slicer", () => findSlicer());
  ipcMain.handle("checks:preview", (_e, p: PosePreview | null) => setPreview(p));
  ipcMain.handle("design:get", () => (project ? readDesign(project) : null));
  ipcMain.handle("design:addRule", (_e, rule) => { const r = addRule(needProject(), { ...rule, by: "user" }); designChanged(); return r; });
  ipcMain.handle("design:removeRule", (_e, id: string) => { const ok = removeRule(needProject(), id); designChanged(); return ok; });
  ipcMain.handle("design:setSweep", (_e, sweep) => { setSweep(needProject(), sweep); designChanged(false); return true; });
  // Protect the current geometry of parts: later builds fail the check if any of them changes.
  ipcMain.handle("design:protect", (_e, ids: string[], note?: string) => {
    const p = needProject();
    const parts = (builder.last?.parts ?? []).filter((x) => ids.includes(x.id) && x.geom && !x.stale);
    if (!parts.length) throw new Error("build the parts first");
    const fingerprints = Object.fromEntries(parts.map((x) => [x.id, x.geom!]));
    const r = addRule(p, { kind: "protected", fingerprints, note: note || `protected ${parts.length} part(s)`, by: "user" });
    designChanged();
    return r;
  });
  ipcMain.handle("tests:list", () => (project ? readTests(project) : []));
  ipcMain.handle("tests:add", (_e, t) => { const r = addTest(needProject(), t, "user"); designChanged(false); return r; });
  ipcMain.handle("tests:update", (_e, id: string, patch) => { const r = updateTest(needProject(), id, patch); designChanged(false); return r; });
  ipcMain.handle("tests:remove", (_e, id: string) => { const r = removeTest(needProject(), id); designChanged(false); return r; });

  ipcMain.handle("agent:start", (_e, kind: AgentKind, resumeId?: string) => startAgent(kind, resumeId));
  ipcMain.handle("agent:send", async (_e, text: string) => {
    if (!agent) {
      const r = await startAgent(getSettings().lastAgent);
      if (!r.ok) throw new Error(r.error);
    }
    send("agent:event", agent!.kind, { type: "user", id: `u${Date.now()}`, text, ts: Date.now() } satisfies AgentEvent);
    await agent!.send(text);
    return true;
  });
  ipcMain.handle("agent:interrupt", () => agent?.interrupt());
  ipcMain.handle("agent:stop", () => { stopAgent(); return true; });
  ipcMain.handle("agent:permission", (_e, requestId: string, decision: PermissionDecision) => agent?.answerPermission(requestId, decision));
  ipcMain.handle("agent:auth", async (_e, kind: AgentKind) => {
    const s = getSettings();
    const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
    if (!bin) return { loggedIn: false, error: "not installed" };
    return kind === "claude" ? claudeAuthStatus(bin.path) : codexAuthStatus(bin.path, project?.dir ?? app.getPath("home"));
  });
  ipcMain.handle("agent:login", async (_e, kind: AgentKind) => {
    const s = getSettings();
    const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
    if (!bin) return { loggedIn: false, error: "not installed" };
    const line = (l: string) => send("agent:login-output", kind, l);
    const r = kind === "claude" ? await claudeLogin(bin.path, line) : await codexLogin(bin.path, project?.dir ?? app.getPath("home"), line);
    send("agent:auth-changed", kind, r);
    return r;
  });
  ipcMain.handle("agent:loginInput", (_e, text: string) => writeLoginInput(text));
  ipcMain.handle("agent:sessions", async (_e, kind: AgentKind) => {
    if (!project) return [];
    if (kind === "claude") return listClaudeSessions(project.dir);
    const bin = pickBinary("codex", getSettings().codexPath);
    return bin ? listCodexSessions(bin.path, project.dir).catch(() => []) : [];
  });

  ipcMain.on("viewer:snapshot-done", (_e, reqId: string, dataUrl: string | null, error?: string) => {
    const w = snapshotWaiters.get(reqId);
    if (!w) return;
    snapshotWaiters.delete(reqId);
    clearTimeout(w.timer);
    if (dataUrl) w.resolve(dataUrl);
    else w.reject(new Error(error || "no image"));
  });
}

function snapshot(req: Omit<SnapshotRequest, "reqId">): Promise<string> {
  if (!win) return Promise.reject(new Error("the window is closed"));
  const reqId = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { snapshotWaiters.delete(reqId); reject(new Error("the view did not answer")); }, 20000);
    snapshotWaiters.set(reqId, { resolve, reject, timer });
    send("viewer:snapshot", { ...req, reqId });
  });
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(async () => {
  const desktopReady = integrateDesktop(join(__dirname, "..", "renderer")); // dock/taskbar/menu icon
  registerIpc();
  registerTools(hub, {
    builder, worker, project: () => project, snapshot, annotations: () => annotations,
    highlight: (ids, message) => send("viewer:highlight", { ids, message }),
    sceneChanged: () => project && send("project:info", project.info),
    fetchReference: (url, filename, folder) => fetchReference(url, filename, folder, agent?.kind === "codex" ? "ChatGPT (Codex)" : "Claude"),
    checks,
    confirm: (message: string, detail: string, yes: string) =>
      confirmBox({
        type: "question",
        buttons: [yes, "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message,
        detail,
      }),
    agentName: () => (agent?.kind === "codex" ? "ChatGPT (Codex)" : "Claude"),
    setPreview,
    designChanged: () => designChanged(false),
  });
  // The CAD tools for agents must never keep the window from opening.
  try { await hub.start(); } catch (e) { console.error("MCP hub:", e); }
  hub.on("activity", (a) => send("mcp:activity", a));
  worker.on("stderr", (d: string) => send("cad:stderr", d));
  worker.start();
  builder.on("state", (s) => send("cad:state", s));
  if (process.env.SLASHCAD_DEBUG) {
    builder.on("start", (x) => console.log("[build] start", x.trigger));
    builder.on("result", (r) => console.log("[build] result", r.n, r.trigger, r.parts.length, "parts", r.seconds, "s", r.sources.map((x: any) => x.error?.message ?? "ok").join("; ")));
    project?.on("changed", () => {});
  }
  builder.on("result", (r) => send("cad:result", r));
  checks.on("report", (rep) => send("checks:report", rep));
  checks.on("sweep", (sw) => send("checks:sweep", sw));
  checks.on("prints", (pr) => send("checks:prints", pr));
  checks.on("running", (k) => send("checks:running", k));
  // Test hook: SLASHCAD_SCREENSHOT=<png> captures the window a few seconds after the first build.
  const shot = process.env.SLASHCAD_SCREENSHOT;
  if (shot) {
    builder.once("result", () => setTimeout(async () => {
      try {
        // SLASHCAD_TEST_CLICK=fx,fy clicks that fraction of the viewport first (selection test).
        if (process.env.SLASHCAD_TEST_CLICK) {
          const [fx, fy] = process.env.SLASHCAD_TEST_CLICK.split(",").map(Number);
          const sel = await win!.webContents.executeJavaScript(`(() => { const v = window.__viewer; const r = v.renderer.domElement.getBoundingClientRect();
            const h = v.pick(r.left + r.width * ${fx}, r.top + r.height * ${fy}); v.select(h); return h ? { partId: h.partId, face: h.face } : null; })()`);
          console.log("[test] selected", JSON.stringify(sel));
          if (sel && sel.face >= 0) console.log("[test] face_info", JSON.stringify(await worker.request("face_info", { id: sel.partId, face: sel.face })));
          await new Promise((r) => setTimeout(r, 1500));
        }
        // SLASHCAD_TEST_TOOLS=name[:base64-json],…: call MCP tools as an agent would and log the text.
        if (process.env.SLASHCAD_TEST_TOOLS && process.env.SLASHCAD_USER_DATA) {
          for (const spec of process.env.SLASHCAD_TEST_TOOLS.split(",")) {
            const [name, b64] = spec.split(":");
            const args = b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : {};
            try {
              const r = await hub.call(name, args);
              console.log(`[tool] ${name}${r.isError ? " (error)" : ""}\n${r.content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n")}`);
            } catch (e: any) { console.log(`[tool] ${name} threw ${e?.message ?? e}`); }
          }
        }
        // SLASHCAD_TEST_SCRIPT=<file.js>: an async function body run in the window; its result is logged.
        if (process.env.SLASHCAD_TEST_SCRIPT && process.env.SLASHCAD_USER_DATA) {
          const body = readFileSync(process.env.SLASHCAD_TEST_SCRIPT, "utf8");
          const out = await win!.webContents.executeJavaScript(`(async () => { ${body}\n })()`);
          console.log("[test] script", JSON.stringify(out));
        }
        const img = await win!.webContents.capturePage();
        writeFileSync(shot, img.toPNG());
        console.log(`screenshot written: ${shot}`);
        const url = await snapshot({ view: (process.env.SLASHCAD_SNAP_VIEW as any) ?? "iso", width: 800, height: 600 });
        writeFileSync(shot.replace(/\.png$/, "-snap.png"), Buffer.from(url.split(",")[1], "base64"));
      } catch (e) { console.error("screenshot failed", e); }
      if (process.env.SLASHCAD_EXIT_AFTER_SCREENSHOT) app.quit();
    }, Number(process.env.SLASHCAD_SCREENSHOT_DELAY_MS ?? 4000)));
  }

  // Test hook: SLASHCAD_E2E_PROMPT runs one real agent turn after the first build (auto-approves
  // permission prompts ONLY in this mode), screenshots the window and the offscreen view, then quits.
  const e2e = process.env.SLASHCAD_E2E_PROMPT;
  if (e2e) {
    builder.once("result", async () => {
      const kind = (process.env.SLASHCAD_E2E_AGENT as AgentKind) || "claude";
      if (process.env.SLASHCAD_E2E_MODEL) setSettings(kind === "claude" ? { claudeModel: process.env.SLASHCAD_E2E_MODEL } : { codexModel: process.env.SLASHCAD_E2E_MODEL });
      const r = await startAgent(kind);
      console.log("[e2e] start", JSON.stringify(r));
      if (!r.ok) return app.quit();
      agent!.on("event", async (ev: AgentEvent) => {
        if (ev.type === "text-delta" || ev.type === "thinking") return;
        console.log("[e2e]", JSON.stringify(ev).slice(0, 400));
        if (ev.type === "permission") agent!.answerPermission(ev.requestId, "allow");
        if (ev.type === "turn-complete") {
          await new Promise((res) => setTimeout(res, 2500));
          const out = process.env.SLASHCAD_SCREENSHOT || join(app.getPath("temp"), "slashcad-e2e.png");
          try {
            writeFileSync(out, (await win!.webContents.capturePage()).toPNG());
            const url = await snapshot({ view: "iso", width: 900, height: 650 });
            writeFileSync(out.replace(/\.png$/, "-snap.png"), Buffer.from(url.split(",")[1], "base64"));
            console.log("[e2e] screenshots", out);
          } catch (e) { console.error("[e2e] screenshot failed", e); }
          app.quit();
        }
      });
      await agent!.send(e2e);
    });
  }
  await desktopReady;
  createWindow();
  win!.webContents.once("did-finish-load", () => {
    const s = getSettings();
    const arg = process.argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && existsSync(a) && !a.endsWith(".js"));
    const initial = process.env.SLASHCAD_PROJECT || arg || s.recentProjects.find((d) => existsSync(d))
      || (!app.isPackaged ? join(app.getAppPath(), "examples", "demo") : undefined);
    if (initial) void openPath(initial, process.env.SLASHCAD_PROJECT || initial.endsWith(join("examples", "demo")) ? { trusted: true } : {});
  });
}).catch((e) => {
  // A start-up error must not leave an invisible process behind (Task Manager only).
  dialog.showErrorBox("SlashCAD could not start", String(e?.stack ?? e));
  app.exit(1);
});

app.on("second-instance", (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  // e.g. double-clicking a .step file while the app runs: open it here.
  const path = argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && !a.endsWith(".js") && existsSync(a));
  if (path) void openPath(path);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (!primaryInstance) return; stopAgent(); worker.stop(); hub.stop(); project?.dispose(); });
