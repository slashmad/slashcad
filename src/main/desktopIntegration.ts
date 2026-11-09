// Makes the running app show its own icon in the dock, taskbar and application menu.
//
// Linux (GNOME/KDE on Wayland and X11): the shell matches a window to a .desktop entry by its
// app_id / WM_CLASS, which Electron derives from `desktopName` in package.json
// ("slashcad"); the window's own icon is ignored on Wayland. deb/rpm install that
// entry and the hicolor icons system-wide. An AppImage or a run from source has neither, so we
// write a user-level entry plus icons to ~/.local/share (standard AppImage desktop integration).
// From source the entry is hidden from the menu (NoDisplay) and only serves the icon.
//
// Windows: the AppUserModelID must equal the one electron-builder puts on the Start menu
// shortcut (appId), otherwise the taskbar groups the window under a generic entry.
// macOS: the dock icon comes from the bundle; a run from source sets it explicitly.
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "com.slashmad.slashcad";
const DESKTOP_ID = "slashcad"; // = package.json desktopName without ".desktop"
const LEGACY_ID = "slashmad-cad-editor"; // entry written by 0.2.7–0.2.8 ("Slashmad CAD Editor")

/** Writes `data` to `file` only when it differs, so repeated starts do not touch the files. */
function writeIfChanged(file: string, data: string | Buffer): boolean {
  try {
    if (existsSync(file) && readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) return false;
  } catch { /* unreadable: rewrite */ }
  writeFileSync(file, data);
  return true;
}

/** Bumps a directory's mtime. Icon themes (GTK, GNOME Shell's St) only rescan when the theme's
 *  base directory changes, not when a file lands in an existing size folder (cf. xdg-icon-resource). */
function touchDir(dir: string): void {
  const now = new Date();
  try { utimesSync(dir, now, now); } catch { /* not ours to touch */ }
}

function quoteExec(arg: string): string {
  // Desktop Entry spec: quote arguments with reserved characters; escape " ` $ \ inside quotes.
  return /^[A-Za-z0-9_./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

function integrateLinux(iconDir: string): boolean {
  // Installed from deb/rpm: the package already provides entry and icons.
  if (existsSync(`/usr/share/applications/${DESKTOP_ID}.desktop`)) return false;
  const appImage = process.env.APPIMAGE;
  if (app.isPackaged && !appImage) return false; // unpacked build: no stable path to point at
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  let iconsChanged = false;

  // Remove the entry and icons an earlier version generated under the old name (only ours).
  const legacyEntry = join(data, "applications", `${LEGACY_ID}.desktop`);
  try {
    if (readFileSync(legacyEntry, "utf8").includes("X-Slashmad-Generated=true")) {
      rmSync(legacyEntry, { force: true });
      for (const size of [64, 256]) rmSync(join(data, "icons", "hicolor", `${size}x${size}`, "apps", `${LEGACY_ID}.png`), { force: true });
      iconsChanged = true;
    }
  } catch { /* none */ }

  for (const size of [64, 256]) {
    const src = join(iconDir, `icon-${size}.png`);
    if (!existsSync(src)) continue;
    const dir = join(data, "icons", "hicolor", `${size}x${size}`, "apps");
    mkdirSync(dir, { recursive: true });
    if (writeIfChanged(join(dir, `${DESKTOP_ID}.png`), readFileSync(src))) iconsChanged = true;
  }
  if (iconsChanged) touchDir(join(data, "icons", "hicolor"));

  const exec = appImage
    ? `${quoteExec(appImage)} --ozone-platform-hint=auto %U`
    : `${quoteExec(process.execPath)} ${quoteExec(app.getAppPath())} --ozone-platform-hint=auto`;
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=SlashCAD",
    "Comment=Local CAD workbench for build123d driven by Claude Code and Codex",
    `Exec=${exec}`,
    `Icon=${DESKTOP_ID}`,
    `StartupWMClass=${DESKTOP_ID}`,
    "Categories=Graphics;",
    "Terminal=false",
    ...(appImage ? [] : ["NoDisplay=true"]),
    "X-SlashCAD-Generated=true",
    "",
  ].join("\n");
  const apps = join(data, "applications");
  mkdirSync(apps, { recursive: true });
  const entryChanged = writeIfChanged(join(apps, `${DESKTOP_ID}.desktop`), entry);
  if (entryChanged) touchDir(apps);
  return entryChanged || iconsChanged;
}

/** Call once before the first window opens. Never throws. Resolves once the desktop shell has
 *  had a moment to load a new or changed entry: the shell matches a window to its app when the
 *  window maps and does not re-match it later, so a window shown at once would keep a generic icon. */
export async function integrateDesktop(iconDir: string): Promise<void> {
  try {
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    else if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(join(iconDir, "icon-256.png"));
    else if (process.platform === "linux") {
      // Test instances (own profile) leave the user's desktop alone unless asked to.
      if (process.env.SLASHCAD_USER_DATA && !process.env.SLASHCAD_DESKTOP_INTEGRATION) return;
      if (integrateLinux(iconDir)) await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    console.warn("desktop integration failed:", e);
  }
}
