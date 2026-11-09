"""Spike: is a native OCCT BREP cache much faster to reload than STEP?

Usage: python bench_brep_cache.py <in.step> <cache.brep>
"""
import json
import os
import sys
import time

import build123d as bd

src, cache = sys.argv[1], sys.argv[2]
t0 = time.perf_counter()
shape = bd.import_step(src)
t_step = time.perf_counter() - t0

t0 = time.perf_counter()
bd.export_brep(shape, cache)
t_write = time.perf_counter() - t0

t0 = time.perf_counter()
again = bd.import_brep(cache)
t_read = time.perf_counter() - t0

print(json.dumps({
    "input": os.path.basename(src),
    "step_import_s": round(t_step, 2),
    "brep_write_s": round(t_write, 2),
    "brep_read_s": round(t_read, 2),
    "brep_mb": round(os.path.getsize(cache) / 1e6, 1),
    "solids_step": len(shape.solids()),
    "solids_brep": len(again.solids()),
    "note": "BREP drops STEP names/colours unless stored separately",
}))
