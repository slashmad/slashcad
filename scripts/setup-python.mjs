// Python environment for the CAD worker.
//   node scripts/setup-python.mjs            -> .venv for development (system Python 3.13)
//   node scripts/setup-python.mjs --bundle   -> build/python-runtime: relocatable CPython
//                                               (python-build-standalone) + pinned packages,
//                                               shipped inside AppImage/deb/rpm/NSIS packages.
//   --target win                             -> cross-prepare a Windows runtime (wheels only)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PBS_TAG = "20261021";
const PY_VERSION = "3.13.17";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const lock = join(root, "python", "requirements.lock");
const args = process.argv.slice(2);
const bundle = args.includes("--bundle");
const hostTarget = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : hostTarget;
// Host interpreter: never pick up whatever virtualenv happens to be first on PATH.
const hostPython = () => process.env.SLASHCAD_HOST_PYTHON
  || ["/usr/bin/python3.13", "/usr/local/bin/python3.13", "/opt/homebrew/bin/python3.13"].find((p) => existsSync(p))
  || "python3.13";
const run = (cmd, a, opts = {}) => { console.log("$", cmd, a.join(" ")); execFileSync(cmd, a, { stdio: "inherit", ...opts }); };

async function download(url, dest) {
  if (existsSync(dest)) return;
  // curl ships with Linux distros and Windows 10+; Node's fetch failed DNS in some sandboxes.
  run("curl", ["-fL", "--retry", "3", "-A", "slashcad-build", "-o", dest + ".part", url]);
  renameSync(dest + ".part", dest);
}

if (!bundle) {
  const venv = join(root, ".venv");
  const py = process.platform === "win32" ? "py" : hostPython();
  const pyArgs = process.platform === "win32" ? ["-3.13", "-m", "venv", venv] : ["-m", "venv", venv];
  if (!existsSync(venv)) run(py, pyArgs);
  const vpy = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  run(vpy, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(vpy, ["-m", "pip", "install", "-r", lock]);
  run(vpy, ["-c", "import build123d, OCP; print('build123d', build123d.__version__, 'OK')"]);
  process.exit(0);
}

const arm = process.arch === "arm64" && target === hostTarget;
function cleanRuntime(out, target) {
  // Privacy/size: no bytecode (embeds the build path) and no console scripts (their shebangs point
  // at the build machine's interpreter); the app only runs `python -m slashcad_worker`.
  function removeTree(dir, test) {
    let n = 0;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (test(e, true)) { rmSync(p, { recursive: true, force: true }); n++; } else n += removeTree(p, test);
      }
    }
    return n;
  }
  const pycache = removeTree(out, (name, isDir) => isDir && name === "__pycache__");
  const binDir = target === "win" ? join(out, "Scripts") : join(out, "bin");
  let scripts = 0;
  if (existsSync(binDir)) {
    for (const e of readdirSync(binDir)) {
      if (/^python[0-9.]*(\.exe|w\.exe)?$/i.test(e) || /\.(dll|pyd)$/i.test(e)) continue;
      rmSync(join(binDir, e), { force: true, recursive: true });
      scripts++;
    }
  }
  rmSync(join(out, "Lib", "site-packages", "bin"), { recursive: true, force: true }); // cross-installed console scripts
  console.log(`cleaned: ${pycache} __pycache__ folders, ${scripts} console scripts`);
  // Precompile with a neutral embedded path (startup ~3.6 s instead of ~7 s on read-only installs
  // such as the AppImage). -B: the compiler's own imports must not write path-bearing .pyc files;
  // -f: recompile everything. Bytecode is platform-independent for the same CPython version, so
  // the host's Python 3.13 also compiles the Windows runtime.
  const lib = target === "win" ? join(out, "Lib") : join(out, "lib");
  const compiler = target === hostTarget ? (target === "win" ? join(out, "python.exe") : join(out, "bin", "python3")) : hostPython();
  run(compiler, ["-B", "-m", "compileall", "-q", "-f", "-j0", "-s", out, "-p", target === "win" ? "C:/slashcad-python" : "/opt/slashcad-python", lib],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
}

if (args.includes("--clean-only")) {
  const out = join(root, "build", target === "win" ? "python-runtime-win" : target === "mac" ? "python-runtime-mac" : "python-runtime");
  cleanRuntime(out, target);
  process.exit(0);
}

const triple = target === "win" ? "x86_64-pc-windows-msvc"
  : target === "mac" ? (arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
  : (arm ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu");
const asset = `cpython-${PY_VERSION}+${PBS_TAG}-${triple}-install_only.tar.gz`;
const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}`;
const cache = join(root, "build", "cache");
mkdirSync(cache, { recursive: true });
const tgz = join(cache, asset);
await download(`${base}/${asset}`, tgz);
await download(`${base}/SHA256SUMS`, join(cache, `SHA256SUMS-${PBS_TAG}`));
const sums = readFileSync(join(cache, `SHA256SUMS-${PBS_TAG}`), "utf8");
const want = sums.split("\n").find((l) => l.trim().endsWith(asset))?.split(/\s+/)[0];
const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
if (!want || want !== got) throw new Error(`checksum mismatch for ${asset}: ${got} != ${want}`);
console.log("sha256 OK", got);

const out = join(root, "build", target === "win" ? "python-runtime-win" : target === "mac" ? "python-runtime-mac" : "python-runtime");
const tmp = join(root, "build", "python-extract");
rmSync(tmp, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
run("tar", ["-xzf", tgz, "-C", tmp]);
renameSync(join(tmp, "python"), out);
rmSync(tmp, { recursive: true, force: true });

if (target === hostTarget) {
  const py = target === "win" ? join(out, "python.exe") : join(out, "bin", "python3");
  run(py, ["-m", "pip", "install", "--no-warn-script-location", "--no-compile", "-r", lock]);
  // -B: the check must not leave .pyc files (they would embed this machine's build path).
  run(py, ["-B", "-c", "import build123d, OCP; print('bundled build123d', build123d.__version__, 'OK')"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
} else {
  // Cross-prepare (e.g. Windows runtime on Linux): binary wheels only, into the target site-packages.
  const site = target === "win" ? join(out, "Lib", "site-packages") : join(out, "lib", "python3.13", "site-packages");
  run(hostPython(), ["-m", "pip", "install", "--no-compile", "--only-binary=:all:", "--platform", target === "win" ? "win_amd64" : "manylinux2014_x86_64",
    "--python-version", "3.13", "--implementation", "cp", "--target", site, "-r", lock]);
}
// Trim: tests and caches are not needed at runtime.
for (const p of ["test", "idlelib", "tkinter", "turtledemo"]) {
  rmSync(join(out, target === "win" ? "Lib" : join("lib", "python3.13"), p), { recursive: true, force: true });
}
cleanRuntime(out, target);
console.log("python runtime ready:", out);
