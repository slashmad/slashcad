// Writes THIRD-PARTY-NOTICES.md from what the packages actually bundle:
// npm production dependencies (renderer bundle) and the Python runtime's installed distributions.
//   node scripts/third-party-notices.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

// npm: production dependencies and their production dependency closure.
const npm = new Map();
const visit = (name) => {
  const e = lock.packages[`node_modules/${name}`];
  if (!e || npm.has(name) || e.dev) return;
  npm.set(name, e);
  for (const d of Object.keys(e.dependencies ?? {})) visit(d);
};
Object.keys(pkg.dependencies ?? {}).forEach(visit);

// Python: metadata of every distribution in the bundled runtime (falls back to .venv).
const pythons = [join(root, "build", "python-runtime", "bin", "python3"), join(root, ".venv", "bin", "python"), join(root, ".venv", "Scripts", "python.exe")];
const py = pythons.find(existsSync);
const code = `
import importlib.metadata as md, json
out = []
for d in md.distributions():
    m = d.metadata
    lic = m.get("License-Expression") or ""
    if not lic:
        cls = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
        lic = "; ".join(cls)
    if not lic:
        # No metadata: recognise the licence from the shipped licence file.
        lic = "unknown"
        for f in d.files or []:
            if any(k in str(f).upper() for k in ("LICENSE", "LICENCE", "COPYING")):
                try:
                    head = f.locate().read_text(errors="ignore")[:1500]
                except OSError:
                    continue
                for needle, name in (("Apache License", "Apache-2.0"), ("MIT License", "MIT"), ("Permission is hereby granted, free of charge", "MIT"),
                                     ("BSD 3-Clause", "BSD-3-Clause"), ("Redistribution and use in source and binary forms", "BSD"),
                                     ("Mozilla Public License", "MPL-2.0"), ("GNU LESSER GENERAL PUBLIC", "LGPL"), ("ISC License", "ISC")):
                    if needle.lower() in head.lower():
                        lic = name
                        break
                if lic != "unknown":
                    break
    urls = m.get_all("Project-URL") or []
    home = m.get("Home-page") or (urls[0].split(",", 1)[-1].strip() if urls else "")
    out.append({"name": m["Name"], "version": m["Version"], "license": lic, "home": home})
print(json.dumps(sorted(out, key=lambda r: r["name"].lower())))
`;
const pyDists = py ? JSON.parse(execFileSync(py, ["-B", "-I", "-c", code], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })) : [];

const lines = [
  "# Third-party notices",
  "",
  `SlashCAD ${pkg.version} is MIT-licensed (see LICENSE). Its installers and archives also contain the`,
  "third-party software below, each under its own licence. Full licence texts are shipped with each component:",
  "Python packages in `resources/python/…/site-packages/<name>-<version>.dist-info/`, CPython in",
  "`resources/python/lib/python3.13/LICENSE.txt` (Windows: `resources/python/LICENSE.txt`), Electron and Chromium in",
  "`LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable, and the texts in `licenses/`.",
  "",
  "## Open CASCADE Technology (OCCT)",
  "",
  "The geometry kernel used through `cadquery-ocp-novtk` (the `libTK*` shared libraries in `cadquery_ocp_novtk.libs`)",
  "is Open CASCADE Technology, © OPEN CASCADE SAS, licensed under the GNU Lesser General Public License version 2.1",
  "with the Open CASCADE exception version 1.0 (`licenses/LGPL-2.1.txt`, `licenses/OCCT-LGPL-exception-1.0.txt`).",
  "It is linked dynamically; you may replace these libraries with your own build. Source code:",
  "https://github.com/Open-Cascade-SAS/OCCT (version 8.0.1) and https://github.com/CadQuery/OCP for the bindings.",
  "",
  "## Runtime",
  "",
  "| Component | Licence |",
  "|---|---|",
  `| Electron ${lock.packages["node_modules/electron"]?.version ?? ""} (incl. Chromium and Node.js) | MIT; Chromium: BSD-3-Clause and others (LICENSES.chromium.html) |`,
  "| CPython 3.13 (python-build-standalone, https://github.com/astral-sh/python-build-standalone) | PSF-2.0; bundled libraries such as OpenSSL, libffi, zlib, SQLite under their own licences (LICENSE.txt) |",
  "",
  "## JavaScript packages (renderer)",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...[...npm.entries()].sort().map(([n, e]) => `| ${n} | ${e.version} | ${e.license ?? "see package"} |`),
  "",
  "## Python packages (CAD worker)",
  "",
  "| Package | Version | Licence | Project |",
  "|---|---|---|---|",
  ...pyDists.map((d) => `| ${d.name} | ${d.version} | ${d.license.replace(/\|/g, "/")} | ${d.home} |`),
  "",
  "SolidCraft, Claude Code and Codex are not bundled: the app uses the user's own installations.",
  "",
];
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
console.log(`THIRD-PARTY-NOTICES.md: ${npm.size} npm packages, ${pyDists.length} Python distributions`);
