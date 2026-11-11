import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Settings } from "../shared/types";

const SETTINGS_VERSION = 3;

const defaults: Settings = {
  settingsVersion: SETTINGS_VERSION,
  language: "en",
  navigation: "fusion",
  rightDragOrbits: true,
  orbitStyle: "turntable",
  orbitAround: "view-center",
  middleDoubleClick: "home",
  zoomToCursor: true,
  reverseZoom: false,
  zoomSpeed: 1,
  smoothZoom: true,
  twoFingerPan: true,
  animateViews: true,
  animationSpeed: 1,
  fitSize: 1,
  fitOnViewChange: false,
  theme: "dark",
  ambientOcclusion: true,
  solidcraftEnabled: true,
  projection: "perspective",
  displayBackend: "auto",
  recentProjects: [],
  lastAgent: "claude",
  buildTimeoutSec: 900,
  printerBed: [220, 220, 250],
  printerNozzle: 0.4,
  printerLayer: 0.2,
  overhangDeg: 45,
  fitClearance: 0.2,
};

let cache: Settings | null = null;

function file(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const saved = JSON.parse(readFileSync(file(), "utf8"));
    cache = { ...defaults, ...saved };
    // v3 (2026-11-09): Fusion mapping with right-drag orbit, turntable around the view centre
    // (deterministic orbit), dark viewport. Replaces the v2 "standard" preset and orbitMode.
    if (!saved.settingsVersion || saved.settingsVersion < 3) {
      const c: any = { ...cache!, navigation: "fusion", rightDragOrbits: true, orbitStyle: "turntable", orbitAround: "view-center", theme: "dark", settingsVersion: SETTINGS_VERSION };
      delete c.orbitMode;
      cache = c;
    }
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export function setSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch };
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("could not save settings", e);
  }
  return cache;
}

export function rememberProject(dir: string): void {
  const s = getSettings();
  setSettings({ recentProjects: [dir, ...s.recentProjects.filter((d) => d !== dir)].slice(0, 12) });
}
