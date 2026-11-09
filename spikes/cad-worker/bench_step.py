"""Spike: time STEP import, tessellation and GLB export with build123d/OCP.

Usage: python bench_step.py <in.step> <out.glb> [linear_deflection_mm] [angular_deflection_rad]
Prints one JSON line with timings and sizes. Never writes next to the input.
"""
import json
import os
import sys
import time

t_start = time.perf_counter()
import build123d as bd  # noqa: E402

t_import_lib = time.perf_counter() - t_start

src, dst = sys.argv[1], sys.argv[2]
lin = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05
ang = float(sys.argv[4]) if len(sys.argv) > 4 else 0.3

t0 = time.perf_counter()
shape = bd.import_step(src)
t_step = time.perf_counter() - t0

solids = shape.solids()
faces = shape.faces()

t0 = time.perf_counter()
ok = bd.export_gltf(shape, dst, binary=True, linear_deflection=lin, angular_deflection=ang)
t_glb = time.perf_counter() - t0

print(json.dumps({
    "input": os.path.basename(src),
    "input_mb": round(os.path.getsize(src) / 1e6, 1),
    "solids": len(solids),
    "faces": len(faces),
    "lib_import_s": round(t_import_lib, 2),
    "step_import_s": round(t_step, 2),
    "tessellate_export_glb_s": round(t_glb, 2),
    "glb_ok": bool(ok),
    "glb_mb": round(os.path.getsize(dst) / 1e6, 1) if os.path.exists(dst) else None,
    "deflection": [lin, ang],
}))
