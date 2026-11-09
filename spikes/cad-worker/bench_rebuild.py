"""Spike: cold vs warm rebuild of a parametric build123d part.

Cold = new Python process (library import + build + export).
Warm = same process, parameter changed, rebuild + export (what a resident worker would do).

Usage: python bench_rebuild.py <out_dir> [n_warm]
"""
import json
import os
import sys
import time

t_start = time.perf_counter()
import build123d as bd  # noqa: E402

t_lib = time.perf_counter() - t_start


def part(width: float, holes: int, fillet: float) -> bd.Part:
    """Bracket with pocket, fillets, counterbored hole grid and a slot."""
    with bd.BuildPart() as p:
        bd.Box(width, 60, 12)
        bd.fillet(p.edges().filter_by(bd.Axis.Z), radius=fillet)
        with bd.BuildSketch(p.faces().sort_by(bd.Axis.Z)[-1]):
            bd.RectangleRounded(width - 20, 40, 4)
        bd.extrude(amount=-6, mode=bd.Mode.SUBTRACT)
        with bd.Locations(p.faces().sort_by(bd.Axis.Z)[0]):
            with bd.GridLocations((width - 16) / max(holes - 1, 1), 44, holes, 2):
                bd.CounterBoreHole(radius=1.7, counter_bore_radius=3.0, counter_bore_depth=2.0)
        with bd.BuildSketch(bd.Plane.XZ):
            with bd.Locations((0, 6)):
                bd.SlotOverall(width * 0.5, 5)
        bd.extrude(amount=40, both=True, mode=bd.Mode.SUBTRACT)
    return p.part


def build_and_export(i: int, width: float, holes: int, out_dir: str) -> dict:
    t0 = time.perf_counter()
    shp = part(width, holes, 5.0)
    t_build = time.perf_counter() - t0
    t0 = time.perf_counter()
    bd.export_gltf(shp, os.path.join(out_dir, f"rebuild_{i}.glb"), binary=True,
                   linear_deflection=0.02, angular_deflection=0.2)
    t_glb = time.perf_counter() - t0
    t0 = time.perf_counter()
    bd.export_step(shp, os.path.join(out_dir, f"rebuild_{i}.step"))
    t_step = time.perf_counter() - t0
    return {"i": i, "width": width, "holes": holes, "faces": len(shp.faces()),
            "build_s": round(t_build, 3), "glb_s": round(t_glb, 3), "step_s": round(t_step, 3)}


out_dir = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
os.makedirs(out_dir, exist_ok=True)
runs = [build_and_export(i, 120 + 10 * i, 4 + i, out_dir) for i in range(n)]
print(json.dumps({"lib_import_s": round(t_lib, 2), "runs": runs}))
