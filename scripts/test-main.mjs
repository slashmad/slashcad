// Regression tests for main-process safety rules (no Electron window, no agent turns, temp files only):
// S01 rules files fail closed, S02 agents start only on a subscription login, C08 a project cannot
// trust itself. Run from the repository root:  node scripts/test-main.mjs
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const require = createRequire(join(repo, "package.json"));
const { build } = require("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "slashcad-test-main-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await build({
    stdin: { contents: "export * from './src/main/design'; export * from './src/main/agents/billing'; export * from './src/main/project';", resolveDir: repo, loader: "ts" },
    outfile: join(scratch, "m.cjs"), bundle: true, platform: "node", format: "cjs", logLevel: "error",
    plugins: [{ name: "mock-electron", setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(join(scratch, "userData"))} };`, loader: "js" }));
    } }],
  });
  const m = require(join(scratch, "m.cjs"));

  // ---- S01: rules files fail closed
  const dir = join(scratch, "project");
  mkdirSync(dir);
  const p = { singleFile: null, stateDir: join(dir, ".slashcad"), abs: (n) => join(dir, n) };
  const rules = join(dir, "slashcad.rules.json");
  const read = (text) => { writeFileSync(rules, text); return m.readDesign(p); };

  let d = read("{ invalid");
  check("S01 invalid JSON is an error, not zero rules", !!d.error && d.unreadable && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 2, rules: [{ kind: "clearance", a: "x", b: "y", min: 1 }] }));
  check("S01 unknown file version is refused", !!d.error && d.unreadable, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "typo", kind: "clearence", a: "x", b: "y", min: 1 }] }));
  check("S01 misspelled kind is an error", !!d.error && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "nomin", kind: "clearance", a: "x", b: "y" }] }));
  check("S01 clearance without min is an error", !!d.error && /min/.test(d.error) && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "zero", kind: "path_clear", part: "nut", direction: [0, 0, 0], distance: 5 }] }));
  check("S01 zero direction is an error", !!d.error && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ kind: "clearance", a: "x", b: "y", min: 0.2 }, { kind: "retained", part: "phone", within: 1 }] }));
  check("S01 valid rules are read, with ids", !d.error && d.rules.length === 2 && d.rules.every((r) => r.id), JSON.stringify(d));

  const broken = JSON.stringify({ version: 1, rules: [{ id: "keep", kind: "clearance", a: "x", b: "y" }] });
  writeFileSync(rules, broken);
  let threw = false;
  try { m.addRule(p, { kind: "clearance", a: "a", b: "b", min: 1 }); } catch { threw = true; }
  check("S01 adding a rule never rewrites a file with invalid rules", threw && readFileSync(rules, "utf8") === broken);

  // ---- S02: only a subscription login may start an agent
  const v = (kind, s) => m.subscriptionVerdict(kind, s).ok;
  check("S02 Claude with claude.ai is allowed", v("claude", { loggedIn: true, method: "claude.ai" }));
  check("S02 Codex with ChatGPT is allowed", v("codex", { loggedIn: true, method: "chatgpt" }));
  check("S02 Claude Console/API billing is refused", !v("claude", { loggedIn: true, method: "console", apiBilling: true }));
  check("S02 Codex API key is refused", !v("codex", { loggedIn: true, method: "apiKey" }));
  check("S02 an unknown method is refused", !v("claude", { loggedIn: true, method: "something" }));
  check("S02 not logged in is refused", !v("codex", { loggedIn: false }));
  check("S02 an unreadable status is refused", !v("claude", { loggedIn: false, error: "timeout" }) && !v("claude", null));

  // ---- C08: a project cannot mark itself as trusted
  const supplied = join(scratch, "supplied");
  mkdirSync(join(supplied, ".slashcad"), { recursive: true });
  writeFileSync(join(supplied, "main.py"), "from build123d import Box\n");
  writeFileSync(join(supplied, ".slashcad", "project.json"), JSON.stringify({ scene: ["main.py"], trusted: true }));
  const proj = new m.Project(supplied);
  check("C08 a trusted flag inside the project is ignored", proj.info.trusted === false && proj.buildableScene().length === 0, JSON.stringify(proj.info));
  proj.setTrusted(true);
  proj.dispose();
  const again = new m.Project(supplied);
  check("C08 the user's decision is remembered by the app", again.info.trusted === true);
  check("C08 the decision is not written into the project", !JSON.stringify(JSON.parse(readFileSync(join(supplied, ".slashcad", "project.json"), "utf8"))).includes("trusted"));
  again.dispose();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
process.exit(failures ? 1 : 0);
