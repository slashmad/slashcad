"""Regression tests for the design checks (synthetic geometry only, temporary files).

Run from the repository root:  .venv/bin/python -I scripts/test-checks.py
Exits non-zero on the first failing case. Covers the review findings of 2026-11-11:
incomplete checks must not pass, stale geometry must not be checked or exported, assembly paths
must not tunnel through thin obstructions, protected parts may be moved, sweeps must not truncate.
"""
import sys
import tempfile
import time
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / "python"))
import build123d as bd  # noqa: E402

from slashcad_worker import checks  # noqa: E402
from slashcad_worker.sources import Part, brep_hash  # noqa: E402
from slashcad_worker.worker import Worker  # noqa: E402

failures = 0


def case(name, ok, detail=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + str(detail)) if detail and not ok else ''}")
    if not ok:
        failures += 1


def part(name, shape):
    fp = brep_hash(shape)
    return Part(name, name, "main.py", shape, None, fp, fp)


def item(p):
    return (p, p.shape, p.geom)


a = part("a", bd.Box(1, 1, 1))
b = part("b", bd.Box(1, 1, 1))

# 1. A check cut short by the time limit is incomplete, never a pass.
r = checks.evaluate([item(a), item(b)], [], deadline=time.monotonic() - 1)
st = r["results"][0]["status"]
case("time limit gives an incomplete verdict", st == "incomplete" and not r["complete"] and r["summary"]["pass"] == 0, r["summary"])

# 2. Overlapping parts fail when checked.
r = checks.evaluate([item(a), item(b)], [])
case("overlap fails", r["results"][0]["status"] == "fail", r["results"][0])

# 3. A thin wall between coarse samples still blocks the path.
mover = part("mover", bd.Box(0.02, 1, 1))
wall = part("wall", bd.Box(0.02, 1, 1).moved(bd.Location((0.125, 0, 0))))
rule = {"id": "path", "kind": "path_clear", "part": "mover", "against": "wall", "direction": [1, 0, 0], "distance": 0.5, "step": 0.25}
r = checks.evaluate([item(mover), item(wall)], [rule])
res = next(x for x in r["results"] if x["id"] == "path")
case("thin obstruction blocks the path", res["status"] == "fail", res["detail"])

# 4. A free path stays free, and retention needs a real catch.
slider = part("slider", bd.Box(10, 10, 3).moved(bd.Location((0, 0, 4.5))))
stop = part("stop", bd.Box(4, 20, 6).moved(bd.Location((60, 0, 4))))
r = checks.evaluate([item(slider), item(stop)], [
    {"id": "free", "kind": "path_clear", "part": "slider", "against": "stop", "direction": [1, 0, 0], "distance": 40},
    {"id": "hit", "kind": "path_clear", "part": "slider", "against": "stop", "direction": [1, 0, 0], "distance": 60},
])
got = {x["id"]: x for x in r["results"]}
case("path free for 40 mm", got["free"]["status"] == "pass", got["free"]["detail"])
case("path blocked within 60 mm, at the 53 mm gap", got["hit"]["status"] == "fail" and " 53.0" in got["hit"]["detail"], got["hit"]["detail"])

tray = part("tray", bd.Box(40, 30, 6) - bd.Pos(0, 0, 2) * bd.Box(36, 26, 6))
phone = part("phone", bd.Pos(0, 0, 1.5) * bd.Box(35.6, 25.6, 3))
lid = part("lid", bd.Pos(0, 0, 3.25) * (bd.Box(40, 30, 0.5) - bd.Box(34, 24, 1)))
r = checks.evaluate([item(tray), item(phone)], [{"id": "held", "kind": "retained", "part": "phone", "against": "tray", "directions": [[0, 0, 1]], "within": 1}])
case("open tray does not retain the phone", r["results"][-1]["status"] == "fail", r["results"][-1]["detail"])
r = checks.evaluate([item(tray), item(phone), item(lid)], [{"id": "held", "kind": "retained", "part": "phone", "against": ["tray", "lid"], "directions": [[0, 0, 1]], "within": 1}])
case("a lip retains the phone", r["results"][-1]["status"] == "pass", r["results"][-1]["detail"])

# 5. Protection is about shape: moving the part is not a change, reshaping it is.
w = Worker(lambda m: None)
w.parts = {"a": a}
w.placements = {"a": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]}
r = w.cmd_check_design(1, {"rules": [{"id": "p", "kind": "protected", "fingerprints": {"a": a.geom}}]})
case("moved protected part passes", next(x for x in r["results"] if x["id"] == "p")["status"] == "pass")
c = part("a", bd.Box(1, 1, 2))
w.parts = {"a": c}
r = w.cmd_check_design(1, {"rules": [{"id": "p", "kind": "protected", "fingerprints": {"a": a.geom}}]})
case("reshaped protected part fails", next(x for x in r["results"] if x["id"] == "p")["status"] == "fail")

with tempfile.TemporaryDirectory(prefix="slashcad-test-") as td:
    root = Path(td)
    params = {"project_dir": td, "cache_dir": str(root / "cache"), "sources": ["main.py"]}
    (root / "main.py").write_text('from build123d import Box\nfrom slashcad import show\nSLIDE = 0\nshow(Box(1, 1, 1), name="solid")\n')
    w = Worker(lambda m: None)
    w.cmd_build(1, params)

    # 6. A sweep refuses more poses than it can check instead of dropping the last ones.
    try:
        w.cmd_sweep(2, {"param": "SLIDE", "values": list(range(400)) + [399.5]})
        case("oversized sweep is refused", False, "no error")
    except ValueError:
        case("oversized sweep is refused", True)
    sw = w.cmd_sweep(3, {"param": "SLIDE", "values": [0, 1, 2.5]})
    case("sweep keeps a non-divisible end value", sw["values"][-1] == 2.5 and sw["complete"], sw["values"])

    # 7. After a failed build, checks and exports refuse the old geometry.
    (root / "main.py").write_text('raise RuntimeError("broken source")\n')
    failed = w.cmd_build(4, params)
    case("failed build keeps the part as stale", failed["parts"][0].get("stale") is True)
    for what, call in (("check", lambda: w.cmd_check_design(5, {})),
                       ("export", lambda: w.cmd_export(6, {"format": "step", "path": str(root / "stale.step")}))):
        try:
            call()
            case(f"stale {what} is refused", False, "no error")
        except RuntimeError:
            case(f"stale {what} is refused", True)
    case("no stale STEP was written", not (root / "stale.step").exists())
    out = w.cmd_export(7, {"format": "step", "path": str(root / "explicit.step"), "allow_stale": True})
    case("explicit stale export is labelled", out.get("stale_sources") == ["main.py"], out)

# 8. The G-code reader does not count retraction priming as extrusion.
with tempfile.NamedTemporaryFile("w", suffix=".gcode", delete=False) as f:
    f.write("M83\n;TYPE:Perimeter\nG1 X1 E1\nG1 E-0.8\n;TYPE:Support material\nG1 E0.8\nG1 X2 E0.5\n")
g = checks.read_gcode(f.name)
case("retraction is not extrusion", g["total_filament_mm"] == 1.5 and g["support_filament_mm"] == 0.5, g)

print(f"\n{'all passed' if not failures else f'{failures} failed'}")
sys.exit(1 if failures else 0)
