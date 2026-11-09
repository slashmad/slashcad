// SolidCraft integration (https://github.com/tangency-labs/solidcraft, MIT OR Apache-2.0).
// We do not bundle or modify SolidCraft. We find the user's installation and:
//  - give agent sessions SolidCraft's own MCP server (`solidcraft-cli mcp`), which bridges to the
//    running desktop app when one listens (control/current.port) and runs headless otherwise;
//  - convert .sc designs to STEP for our viewer (`solidcraft-cli run --in X.sc --out Y.step`);
//  - launch the desktop app on a design or STEP file.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { getSettings } from "./settings";

const isWin = process.platform === "win32";

export interface SolidcraftInfo {
  cli: string | null;
  version: string;
  app: string | null; // desktop executable (or AppImage)
  running: boolean;
  port: number | null;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of isWin ? [`${name}.exe`, `${name}.cmd`] : [name]) {
      const p = join(dir, n);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

/** Folder that holds control/current.port and PORT.token (see SolidCraft docs/control-protocol.md). */
export function controlDir(): string {
  if (process.env.SOLIDCRAFT_CONTROL_DIR) return process.env.SOLIDCRAFT_CONTROL_DIR;
  if (isWin) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SolidCraft", "control");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "SolidCraft", "control");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "solidcraft", "control");
}

function findCli(): string | null {
  const s = getSettings();
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    s.solidcraftCliPath,
    onPath("solidcraft-cli"),
    join(homedir(), ".local", "bin", "solidcraft-cli"),
    isWin ? join(local, "Programs", "SolidCraft", "solidcraft-cli.exe") : "",
    isWin ? join(process.env.ProgramFiles ?? "C:\\Program Files", "SolidCraft", "solidcraft-cli.exe") : "",
    "/usr/bin/solidcraft-cli",
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function findApp(cli: string | null): string | null {
  const s = getSettings();
  if (s.solidcraftAppPath && existsSync(s.solidcraftAppPath)) return s.solidcraftAppPath;
  const p = onPath("solidcraft");
  if (p) return p;
  // The AppImage writes a CLI wrapper that execs the AppImage itself.
  if (cli && !isWin) {
    try {
      const m = readFileSync(cli, "utf8").match(/exec\s+"([^"]+\.AppImage)"/);
      if (m && existsSync(m[1])) return m[1];
    } catch { /* binary, not a wrapper */ }
  }
  const desktop = join(homedir(), ".local", "share", "applications", "io.tangencylabs.solidcraft.desktop");
  try {
    const m = readFileSync(desktop, "utf8").match(/^Exec="?([^"\n]+?)"?\s+%[fFuU]/m);
    if (m && existsSync(m[1])) return m[1];
  } catch { /* not installed that way */ }
  if (isWin && cli) {
    const exe = cli.replace(/solidcraft-cli\.exe$/i, "solidcraft.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

let cached: { at: number; info: SolidcraftInfo } | null = null;

export function solidcraftInfo(force = false): SolidcraftInfo {
  if (!force && cached && Date.now() - cached.at < 5000) return { ...cached.info, ...runningState() };
  const cli = findCli();
  let version = "";
  if (cli) {
    try { version = execFileSync(cli, ["--version"], { timeout: 15000, encoding: "utf8", windowsHide: true }).trim().split("\n")[0]; } catch { /* broken install */ }
  }
  const info: SolidcraftInfo = { cli: version ? cli : null, version, app: findApp(cli), ...runningState() };
  cached = { at: Date.now(), info };
  return info;
}

function runningState(): { running: boolean; port: number | null } {
  try {
    const port = Number(readFileSync(join(controlDir(), "current.port"), "utf8").trim());
    return Number.isFinite(port) && port > 0 ? { running: true, port } : { running: false, port: null };
  } catch {
    return { running: false, port: null };
  }
}

export function launchSolidcraft(file?: string): boolean {
  const info = solidcraftInfo();
  if (!info.app) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SOLIDCRAFT_APPIMAGE_CLI;
  const child = spawn(info.app, file ? [file] : [], { detached: true, stdio: "ignore", env, windowsHide: false });
  child.unref();
  return true;
}

/** MCP launch spec for SolidCraft's server, or null when disabled / not installed. */
export function solidcraftMcp(projectDir: string): { command: string; args: string[]; env: Record<string, string> } | null {
  const s = getSettings();
  if (s.solidcraftEnabled === false) return null;
  const info = solidcraftInfo();
  if (!info.cli) return null;
  return { command: info.cli, args: ["mcp", "--allow-path", projectDir], env: {} };
}

export const SOLIDCRAFT_INSTRUCTIONS = `
SolidCraft (a parametric CAD app with a timeline, sketches and constraints) is also available through the "solidcraft" MCP server. When the user has SolidCraft open, the server bridges to that window and the user watches you model there; otherwise it runs headless.
- Use build123d scripts for code-driven parts (the default), and SolidCraft when the user asks for it or wants an editable feature timeline / sketch-based design.
- Keep SolidCraft designs as .sc files inside the project folder and call SolidCraft's save tool after changes: SlashCAD shows .sc files that are in its scene (it exports them to STEP on every save), so markers, measuring and sections work on them too. Add the file to the scene with set_scene if it is not shown yet.
- SolidCraft's skill_reference tool has its modelling guides (solidcraft-modeling, solidcraft-checking …); read them before larger SolidCraft work.`;
