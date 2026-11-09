"""Turn project sources (.py build123d scripts, .step/.stp, .brep) into named parts."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sys
import traceback
import types
from dataclasses import dataclass, field

import build123d as bd

STEP_EXT = (".step", ".stp")
BREP_EXT = (".brep",)
SCRIPT_EXT = (".py",)
SC_EXT = (".sc",)  # SolidCraft designs, exported to STEP with the user's solidcraft-cli
SUPPORTED = STEP_EXT + BREP_EXT + SCRIPT_EXT + SC_EXT


@dataclass
class Part:
    id: str
    name: str
    source: str
    shape: object
    color: tuple | None
    key: str


@dataclass
class SourceResult:
    source: str
    parts: list = field(default_factory=list)
    log: str = ""
    error: dict | None = None
    seconds: float = 0.0


def color_tuple(c) -> tuple | None:
    if c is None:
        return None
    for attr in ("to_tuple",):
        if hasattr(c, attr):
            return tuple(float(x) for x in getattr(c, attr)())
    try:
        return tuple(float(x) for x in c)
    except TypeError:
        return None


def to_shape(obj):
    """Unwrap builder contexts and other build123d holders into a Shape."""
    for attr in ("part", "sketch", "line"):
        if isinstance(obj, (bd.BuildPart, bd.BuildSketch, bd.BuildLine)) and hasattr(obj, attr):
            val = getattr(obj, attr)
            if val is not None:
                return val
    if isinstance(obj, bd.Shape):
        return obj
    if isinstance(obj, (list, tuple)) and obj and all(isinstance(o, bd.Shape) for o in obj):
        return bd.Compound(children=list(obj))
    return None


def leaves(shape, prefix: str, inherited_color=None):
    """Yield (path, shape, colour) for assembly leaves; a plain shape is one leaf."""
    children = list(getattr(shape, "children", []) or [])
    if isinstance(shape, bd.Compound) and children:
        for i, ch in enumerate(children):
            label = getattr(ch, "label", "") or f"{i}"
            col = getattr(ch, "color", None) or inherited_color
            yield from leaves(ch, f"{prefix}/{label}", col)
        return
    yield prefix, shape, getattr(shape, "color", None) or inherited_color


def brep_hash(shape) -> str:
    """Exact geometric fingerprint via binary BREP serialisation."""
    from OCP.BinTools import BinTools

    fd, tmp = __import__("tempfile").mkstemp(suffix=".bbrep")
    os.close(fd)
    try:
        BinTools.Write_s(shape.wrapped, tmp)
        with open(tmp, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    finally:
        os.unlink(tmp)


def _file_fingerprint(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()


# ---------------------------------------------------------------- STEP / BREP


def load_step(path: str, cache_dir: str, progress, display: str | None = None) -> object:
    """STEP import is slow (10-110 s); cache as binary BREP + label/colour metadata."""
    fp = _file_fingerprint(path)
    cdir = os.path.join(cache_dir, "step")
    os.makedirs(cdir, exist_ok=True)
    brep, meta_path = os.path.join(cdir, fp + ".brep"), os.path.join(cdir, fp + ".json")
    if os.path.exists(brep) and os.path.exists(meta_path):
        progress(f"Reading cache for {display or os.path.basename(path)}")
        shape = bd.import_brep(brep)
        with open(meta_path) as f:
            meta = json.load(f)
        _apply_meta(shape, meta)
        return shape
    progress(f"Importing STEP {display or os.path.basename(path)} (the first time can take minutes)")
    shape = bd.import_step(path)
    bd.export_brep(shape, brep + ".tmp")
    os.replace(brep + ".tmp", brep)
    with open(meta_path, "w") as f:
        json.dump(_collect_meta(shape), f)
    return shape


def _collect_meta(shape) -> dict:
    return {
        "label": getattr(shape, "label", "") or "",
        "color": color_tuple(getattr(shape, "color", None)),
        "children": [_collect_meta(c) for c in (getattr(shape, "children", []) or [])]
        if isinstance(shape, bd.Compound) else [],
    }


def _direct_subshapes(shape) -> list:
    from OCP.TopoDS import TopoDS_Iterator

    it, out = TopoDS_Iterator(shape.wrapped), []
    while it.More():
        out.append(bd.Shape.cast(it.Value()))
        it.Next()
    return out


def _apply_meta(shape, meta: dict):
    """Re-attach labels/colours and rebuild the assembly tree that BREP files do not store."""
    if meta.get("label"):
        shape.label = meta["label"]
    if meta.get("color"):
        shape.color = bd.Color(*meta["color"])
    child_meta = meta.get("children", [])
    if isinstance(shape, bd.Compound) and child_meta:
        kids = list(getattr(shape, "children", []) or []) or _direct_subshapes(shape)
        for ch, m in zip(kids, child_meta):
            _apply_meta(ch, m)
        if not getattr(shape, "children", None):
            shape.children = kids
    return shape


def load_sc(path: str, cache_dir: str, progress) -> object:
    """SolidCraft .sc design -> STEP via `solidcraft-cli run --in X.sc --out Y.step` -> cached STEP path."""
    import subprocess

    cli = os.environ.get("SLASHCAD_SOLIDCRAFT_CLI")
    if not cli:
        raise RuntimeError("SolidCraft (solidcraft-cli) was not found; install SolidCraft or set its path in Settings > Agents.")
    fp = _file_fingerprint(path)
    cdir = os.path.join(cache_dir, "sc")
    os.makedirs(cdir, exist_ok=True)
    step = os.path.join(cdir, fp + ".step")
    if not os.path.exists(step):
        progress(f"Exporting SolidCraft design {os.path.basename(path)}")
        env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
        r = subprocess.run([cli, "run", "--in", path, "--out", step + ".tmp.step", "--quiet"], capture_output=True, text=True,
                           timeout=600, env=env)
        if r.returncode != 0 or not os.path.exists(step + ".tmp.step"):
            raise RuntimeError(f"solidcraft-cli could not export {os.path.basename(path)}: {(r.stderr or r.stdout).strip()[-1500:]}")
        os.replace(step + ".tmp.step", step)
    return load_step(step, cache_dir, progress, display=os.path.basename(path))


# ---------------------------------------------------------------- scripts

_shown: list = []


def _show(*objs, name=None, color=None, names=None, colors=None, **_kw):
    for i, o in enumerate(objs):
        n = name if name and len(objs) == 1 else (names[i] if names and i < len(names) else name)
        c = color if color is not None and len(objs) == 1 else (colors[i] if colors and i < len(colors) else color)
        _shown.append((o, n, c))


_context = {"cache_dir": None, "project_dir": None}
_loaded: dict = {}


def _load_step_cached(path: str):
    """`slashcad.load_step(path)`: STEP/SC/BREP geometry for use in a script (fits, positions), using
    the worker's BREP cache and an in-memory cache, so a reference model costs ~0.1 s per rebuild."""
    project_dir = _context["project_dir"] or os.getcwd()
    abs_path = path if os.path.isabs(path) else os.path.join(project_dir, path)
    fp = _file_fingerprint(abs_path)
    if fp not in _loaded:
        cache = _context["cache_dir"] or os.path.join(project_dir, ".slashcad", "cache")
        ext = os.path.splitext(abs_path)[1].lower()
        noop = lambda *a, **k: None  # noqa: E731
        _loaded[fp] = (load_sc(abs_path, cache, noop) if ext in SC_EXT else
                       bd.import_brep(abs_path) if ext in BREP_EXT else load_step(abs_path, cache, noop))
    return _loaded[fp]


def _install_shims() -> None:
    """`from slashcad import show` and ocp_vscode/cq-editor style calls all land in _shown.
    `slashmad` (the app's former name) stays importable for older scripts."""
    sm = types.ModuleType("slashcad")
    sm.show = _show
    sm.load_step = _load_step_cached
    sm.show_object = lambda obj, name=None, options=None, **kw: _show(obj, name=name,
                                                                     color=(options or {}).get("color"))
    sys.modules["slashcad"] = sm
    sys.modules["slashmad"] = sm
    ocp = types.ModuleType("ocp_vscode")
    ocp.show = _show
    ocp.show_object = sm.show_object
    ocp.show_all = lambda *a, **k: None
    for noop in ("set_port", "set_defaults", "reset_show", "set_viewer_config", "Camera", "Collapse"):
        setattr(ocp, noop, (lambda *a, **k: None))
    sys.modules["ocp_vscode"] = ocp


def _purge_project_modules(project_dir: str) -> None:
    root = os.path.abspath(project_dir) + os.sep
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if f and os.path.abspath(f).startswith(root):
            del sys.modules[name]


def _user_frame(tb, path: str):
    line = None
    for fr in traceback.extract_tb(tb):
        if os.path.abspath(fr.filename) == os.path.abspath(path):
            line = fr.lineno
    return line


def run_script(path: str, project_dir: str):
    """Execute a build123d script; return list of (obj, name, colour) and captured output."""
    _install_shims()
    _purge_project_modules(project_dir)
    _shown.clear()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = compile(src, path, "exec")
    ns = {"__name__": "__main__", "__file__": path, "show": _show, "show_object": sys.modules["slashcad"].show_object}
    out = io.StringIO()
    old_cwd, old_path = os.getcwd(), list(sys.path)
    sys.path[:0] = [os.path.dirname(path), project_dir]
    try:
        os.chdir(project_dir)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(code, ns)
    finally:
        os.chdir(old_cwd)
        sys.path[:] = old_path
    shown = list(_shown)
    if not shown:
        if "result" in ns:
            shown = [(ns["result"], None, None)]
        else:
            shown = [(v, k, None) for k, v in ns.items()
                     if not k.startswith("_") and isinstance(v, (bd.Part, bd.Solid, bd.Compound, bd.BuildPart))]
    return shown, out.getvalue()


# ---------------------------------------------------------------- dispatcher


def load_source(rel: str, project_dir: str, cache_dir: str, quality: str, progress) -> SourceResult:
    import time

    t0 = time.perf_counter()
    path = os.path.join(project_dir, rel)
    res = SourceResult(source=rel)
    base = os.path.splitext(os.path.basename(rel))[0]
    try:
        ext = os.path.splitext(rel)[1].lower()
        if ext in STEP_EXT or ext in BREP_EXT or ext in SC_EXT:
            if ext in STEP_EXT:
                shape = load_step(path, cache_dir, progress)
            elif ext in SC_EXT:
                shape = load_sc(path, cache_dir, progress)
            else:
                shape = bd.import_brep(path)
            fp = _file_fingerprint(path)
            root = getattr(shape, "label", "") or base
            for i, (lpath, leaf, col) in enumerate(leaves(shape, root)):
                res.parts.append(Part(id=f"{rel}#{i}:{lpath}", name=lpath.split("/")[-1], source=rel, shape=leaf,
                                      color=color_tuple(col), key=hashlib.sha1(f"{fp}|{i}|{quality}".encode()).hexdigest()))
        elif ext in SCRIPT_EXT:
            progress(f"Running {rel}")
            _context["cache_dir"], _context["project_dir"] = cache_dir, project_dir
            shown, res.log = run_script(path, project_dir)
            n = 0
            for obj, name, col in shown:
                shape = to_shape(obj)
                if shape is None:
                    continue
                label = name or getattr(shape, "label", "") or (base if len(shown) == 1 else f"{base}_{n}")
                for lpath, leaf, lcol in leaves(shape, label):
                    c = color_tuple(col) if col is not None and not isinstance(col, str) else None
                    if isinstance(col, str):
                        try:
                            c = color_tuple(bd.Color(col))
                        except Exception:
                            c = None
                    key = hashlib.sha1(f"{brep_hash(leaf)}|{quality}".encode()).hexdigest()
                    res.parts.append(Part(id=f"{rel}#{lpath}", name=lpath.split("/")[-1], source=rel, shape=leaf,
                                          color=c or color_tuple(lcol), key=key))
                    n += 1
            if not res.parts:
                # Not an error: a fresh script may only hold comments. The log tells agents why.
                res.log = (res.log + "\nNote: the script showed no geometry (call show(obj) or set a variable named result).").strip()
        else:
            res.error = {"message": f"Unsupported file type: {ext}", "line": None, "traceback": ""}
    except SyntaxError as e:
        res.error = {"message": f"SyntaxError: {e.msg}", "line": e.lineno, "traceback": traceback.format_exc()}
    except BaseException as e:  # noqa: BLE001 - user code may raise anything, even SystemExit
        res.error = {"message": f"{type(e).__name__}: {e}", "line": _user_frame(e.__traceback__, path),
                     "traceback": traceback.format_exc()}
    res.seconds = time.perf_counter() - t0
    return res
