// Execution trust for Python model scripts, owned by the app (never by the project).
// A folder or file the user received must not be able to grant itself permission to run code,
// so the decision lives in <userData>/trusted-projects.json, keyed by the canonical (real) path of
// the project folder or the single opened file. A `trusted` flag inside a project's own
// .slashcad/project.json is ignored.
import { app } from "electron";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface TrustFile { version: 1; entries: Record<string, { trustedAt: number }> }

let cache: TrustFile | null = null;

function file(): string {
  return join(app.getPath("userData"), "trusted-projects.json");
}

function load(): TrustFile {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(file(), "utf8"));
    cache = { version: 1, entries: j && typeof j.entries === "object" ? j.entries : {} };
  } catch {
    cache = { version: 1, entries: {} };
  }
  return cache;
}

/** Canonical identity: the resolved real path (symlinks and relative parts removed). */
export function trustKey(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function isTrusted(path: string): boolean {
  return !!load().entries[trustKey(path)];
}

export function setTrusted(path: string, trusted: boolean): void {
  const t = load();
  const k = trustKey(path);
  if (trusted) t.entries[k] = { trustedAt: Date.now() };
  else delete t.entries[k];
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(t, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("could not save trust", e);
  }
}
