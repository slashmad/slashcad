"""Command handlers. State lives here between builds: last parts, keys and shapes."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time

import build123d as bd

from . import checks
from .mesh import tessellate, write_smsh
from .sources import SUPPORTED, _context, load_source


def _location(m) -> bd.Location:
    """User placement: a column-major 4x4 rigid matrix (THREE.Matrix4.elements) -> Location."""
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14])
    return bd.Location(t)


def _bbox(shape) -> list:
    bb = shape.bounding_box()
    return [[bb.min.X, bb.min.Y, bb.min.Z], [bb.max.X, bb.max.Y, bb.max.Z]]


class Worker:
    def __init__(self, send):
        self.send = send
        self.parts: dict = {}      # id -> Part (last successful build)
        self.prev_keys: dict = {}  # id -> mesh key
        self.placements: dict = {}  # id -> column-major 4x4 matrix set by the user in the view
        self.last_build: dict = {}  # params of the last build (sources, dirs, quality) for sweeps
        self.materials: dict = checks.material_table(None)
        self.stale_sources: set = set()  # sources whose last build failed: their parts are old geometry
        self.overrides: dict = {}  # pose preview of the last build ({source: {NAME: value}})

    def _shape(self, part):
        """The part as placed by the user. Meshes stay in the source frame; the view applies the same matrix."""
        m = self.placements.get(part.id)
        if not m or len(m) != 16:
            return part.shape
        return part.shape.moved(_location(m))

    # ------------------------------------------------------------ helpers
    def _progress(self, rid):
        return lambda msg, **kw: self.send({"event": "progress", "id": rid, "message": msg, **kw})

    # ------------------------------------------------------------ commands
    def cmd_ping(self, rid, p):
        return {"pong": True, "time": time.time()}

    def cmd_build(self, rid, p):
        """Build the given sources. Unchanged parts reuse cached meshes."""
        project_dir = p["project_dir"]
        cache_dir = p["cache_dir"]
        quality = p.get("quality", "normal")
        mesh_dir = os.path.join(cache_dir, "mesh")
        os.makedirs(mesh_dir, exist_ok=True)
        progress = self._progress(rid)
        if "placements" in p:
            self.placements = p.get("placements") or {}
        self.materials = checks.material_table(p.get("materials"))
        _context["materials"] = self.materials
        overrides = p.get("overrides") or {}  # {source: {NAME: value}}: a pose preview, never written to disk
        self.overrides = overrides
        self.last_build = {k: p.get(k) for k in ("project_dir", "cache_dir", "sources", "quality")}
        t0 = time.perf_counter()
        out_parts, sources, new_parts = [], [], {}
        for rel in p.get("sources", []):
            if not rel.lower().endswith(SUPPORTED):
                continue
            res = load_source(rel, project_dir, cache_dir, quality, progress, overrides.get(rel))
            sources.append({"source": rel, "log": res.log[-20000:], "error": res.error, "seconds": round(res.seconds, 3),
                            "parts": len(res.parts)})
            for i, part in enumerate(res.parts):
                mesh_path = os.path.join(mesh_dir, part.key + ".smsh")
                cached = os.path.exists(mesh_path)
                if not cached:
                    progress(f"Tessellating {part.name}", done=i, total=len(res.parts))
                    m = tessellate(part.shape, quality)
                    write_smsh(mesh_path, m, {"name": part.name, "deflection": m["deflection"]})
                new_parts[part.id] = part
                out_parts.append({
                    "id": part.id, "name": part.name, "source": part.source, "key": part.key,
                    "color": part.color, "mesh": mesh_path, "bbox": _bbox(self._shape(part)),
                    "changed": self.prev_keys.get(part.id) != part.key, "geom": part.geom, "material": part.material,
                })
        # Keep previous geometry for sources that failed, so the view does not go blank.
        failed = {s["source"] for s in sources if s["error"]}
        self.stale_sources = failed
        for pid, part in self.parts.items():
            if part.source in failed and pid not in new_parts:
                new_parts[pid] = part
                out_parts.append({"id": pid, "name": part.name, "source": part.source, "key": part.key,
                                  "color": part.color, "mesh": os.path.join(mesh_dir, part.key + ".smsh"),
                                  "bbox": _bbox(self._shape(part)), "changed": False, "stale": True,
                                  "geom": part.geom, "material": part.material})
        removed = [pid for pid in self.prev_keys if pid not in new_parts]
        self.parts = new_parts
        self.prev_keys = {pid: pt.key for pid, pt in new_parts.items()}
        return {"parts": out_parts, "sources": sources, "removed": removed,
                "seconds": round(time.perf_counter() - t0, 3), "quality": quality}

    def cmd_set_placements(self, rid, p):
        self.placements = p.get("placements") or {}
        return {"placed": len(self.placements)}

    def _fresh(self, parts, what: str, allow_stale: bool = False) -> None:
        """Refuse to check or export the last good geometry of a source whose build failed."""
        stale = sorted({pt.source for pt in parts if pt.source in self.stale_sources})
        if stale and not allow_stale:
            raise RuntimeError(f"{', '.join(stale)} has a build error, so its parts are the last good geometry, not the current file. "
                               f"Fix the error first; {what} would otherwise describe old geometry.")

    def _provenance(self, parts) -> dict:
        out = {}
        stale = sorted({pt.source for pt in parts if pt.source in self.stale_sources})
        if stale:
            out["stale_sources"] = stale
        prev = {src: v for src, v in (self.overrides or {}).items() if any(pt.source == src for pt in parts)}
        if prev:
            out["preview"] = prev
        return out

    def _select(self, ids):
        if not ids:
            return list(self.parts.values())
        missing = [i for i in ids if i not in self.parts]
        if missing:
            raise KeyError(f"unknown part ids: {missing}")
        return [self.parts[i] for i in ids]

    def cmd_inspect(self, rid, p):
        out = []
        for part in self._select(p.get("ids")):
            s = self._shape(part)
            valid = s.is_valid() if callable(getattr(s, "is_valid", None)) else bool(getattr(s, "is_valid", True))
            info = {"id": part.id, "name": part.name, "source": part.source, "bbox": _bbox(s), "valid": valid,
                    "solids": len(s.solids()), "faces": len(s.faces()), "edges": len(s.edges())}
            try:
                info["volume_mm3"] = round(s.volume, 4)
                info["area_mm2"] = round(s.area, 4)
                c = s.center(bd.CenterOf.MASS) if info["volume_mm3"] > 0 else s.center()
                info["center_of_mass"] = [round(c.X, 4), round(c.Y, 4), round(c.Z, 4)]
                mat = checks.material_info(part.material, self.materials)
                if part.material:
                    info["material"] = part.material
                if mat and mat.get("density"):
                    info["mass_g"] = round(info["volume_mm3"] * float(mat["density"]) / 1000.0, 3)
            except Exception as e:  # noqa: BLE001
                info["properties_error"] = str(e)
            out.append(info)
        massed = [i for i in out if "mass_g" in i]
        total = None
        if massed:
            m = sum(i["mass_g"] for i in massed)
            com = [round(sum(i["mass_g"] * i["center_of_mass"][k] for i in massed) / m, 3) for k in range(3)] if m > 0 else None
            total = {"mass_g": round(m, 3), "center_of_mass": com, "parts_with_material": len(massed), "parts_without_material": len(out) - len(massed)}
        return {"parts": out, "total": total}

    def cmd_face_info(self, rid, p):
        """Describe one B-rep face. Face indices match the mesh face ranges (TopExp order)."""
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus

        part = self._select([p["id"]])[0]
        faces = self._shape(part).faces()
        i = int(p["face"])
        if not 0 <= i < len(faces):
            raise IndexError(f"face {i} does not exist (the part has {len(faces)} faces)")
        f = faces[i]
        r3 = lambda v: [round(v.X, 4), round(v.Y, 4), round(v.Z, 4)]  # noqa: E731
        ad = BRepAdaptor_Surface(f.wrapped)
        kind = ad.GetType()
        info = {"id": part.id, "face": i, "area_mm2": round(f.area, 4), "center": r3(f.center()), "bbox": _bbox(f)}
        names = {GeomAbs_Plane: "plane", GeomAbs_Cylinder: "cylinder", GeomAbs_Cone: "cone", GeomAbs_Sphere: "sphere", GeomAbs_Torus: "torus"}
        info["type"] = names.get(kind, "freeform")
        ax_dir = lambda ax: [round(ax.Direction().X(), 4), round(ax.Direction().Y(), 4), round(ax.Direction().Z(), 4)]  # noqa: E731
        ax_loc = lambda ax: [round(ax.Location().X(), 4), round(ax.Location().Y(), 4), round(ax.Location().Z(), 4)]  # noqa: E731
        if kind == GeomAbs_Plane:
            info["normal"] = r3(f.normal_at())
        elif kind == GeomAbs_Cylinder:
            c = ad.Cylinder()
            info.update(radius_mm=round(c.Radius(), 4), diameter_mm=round(2 * c.Radius(), 4), axis=ax_dir(c.Axis()), axis_point=ax_loc(c.Axis()))
        elif kind == GeomAbs_Cone:
            c = ad.Cone()
            info.update(ref_radius_mm=round(c.RefRadius(), 4), half_angle_deg=round(c.SemiAngle() * 57.29578, 3), axis=ax_dir(c.Axis()))
        elif kind == GeomAbs_Sphere:
            info["radius_mm"] = round(ad.Sphere().Radius(), 4)
        elif kind == GeomAbs_Torus:
            t = ad.Torus()
            info.update(major_radius_mm=round(t.MajorRadius(), 4), minor_radius_mm=round(t.MinorRadius(), 4), axis=ax_dir(t.Axis()))
        return info

    def cmd_measure(self, rid, p):
        a, b = self._select([p["a"], p["b"]])
        sa, sb = self._shape(a), self._shape(b)
        d = sa.distance_to(sb)
        inter = checks.overlap_volume(sa, sb)
        return {"a": a.id, "b": b.id, "min_distance_mm": round(d, 5),
                "intersection_volume_mm3": None if inter is None else round(inter, 5)}

    def cmd_export(self, rid, p):
        parts = self._select(p.get("ids"))
        self._fresh(parts, "the export", bool(p.get("allow_stale")))
        fmt = p.get("format", "step").lower()
        path = p["path"]
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        shapes = []
        for part in parts:
            s = self._shape(part)
            s.label = part.name
            if part.color:
                s.color = bd.Color(*part.color)
            shapes.append(s)
        shape = shapes[0] if len(shapes) == 1 else bd.Compound(children=shapes, label="export")
        if fmt == "step":
            bd.export_step(shape, path)
        elif fmt == "stl":
            bd.export_stl(shape, path)
        elif fmt == "brep":
            bd.export_brep(shape, path)
        elif fmt in ("glb", "gltf"):
            bd.export_gltf(shape, path, binary=fmt == "glb")
        elif fmt == "3mf":
            mesher = bd.Mesher()
            for s in shapes:
                mesher.add_shape(s, linear_deflection=0.01, angular_deflection=0.1)
            mesher.write(path)
        else:
            raise ValueError(f"unknown format {fmt}")
        return {"path": path, "bytes": os.path.getsize(path), "parts": len(parts), **self._provenance(parts)}

    # ------------------------------------------------------------ design checks
    def _items(self, parts=None, extra_parts=None):
        """(part, placed shape, fingerprint) for the given parts (default: all of the last build)."""
        out = []
        for part in (parts if parts is not None else list(self.parts.values())):
            m = self.placements.get(part.id)
            fp = part.geom + ("|" + ",".join(f"{x:.6g}" for x in m) if m else "")
            out.append((part, self._shape(part), fp))
        return out

    def cmd_check_design(self, rid, p):
        ids = p.get("ids")
        parts = self._select(ids) if ids else list(self.parts.values())
        self._fresh(parts, "the check")
        deadline = time.monotonic() + float(p.get("time_limit", 120))
        rep = checks.evaluate(self._items(parts), p.get("rules") or [], float(p.get("near", 0.5)), deadline)
        rep.update(self._provenance(parts))
        return rep

    def cmd_sweep(self, rid, p):
        """Rebuild the scripts that define parameter `param` at each value (in memory), then check
        clearances and the rules at every pose. The project files are not changed."""
        name = str(p["param"])
        values = [float(v) for v in p["values"]]
        if not values:
            raise ValueError("no values to check")
        if len(values) > 400:
            raise ValueError(f"{len(values)} poses requested; at most 400 (use a larger step)")
        lb = self.last_build
        if not lb.get("sources"):
            raise RuntimeError("build the project first")
        progress = self._progress(rid)
        pat = re.compile(rf"^{re.escape(name)}(\s*:\s*(?:int|float))?\s*=\s*-?\d", re.M)
        scripts = []
        for rel in lb["sources"]:
            if rel.endswith(".py") and (p.get("file") in (None, rel)):
                try:
                    with open(os.path.join(lb["project_dir"], rel), encoding="utf-8") as f:
                        if pat.search(f.read()):
                            scripts.append(rel)
                except OSError:
                    pass
        if not scripts:
            raise ValueError(f"no shown script defines a top-level parameter {name} (e.g. `{name} = 0`)")
        sel = p.get("ids")
        rules = p.get("rules") or []
        near = float(p.get("near", 0.5))
        static = [pt for pt in self.parts.values() if pt.source not in scripts]
        self._fresh(static, "the sweep")
        cache: dict = {}
        poses, pair_min = [], {}
        deadline = time.monotonic() + float(p.get("time_limit", 600))
        t0 = time.perf_counter()
        for k, v in enumerate(values):
            if time.monotonic() > deadline:
                break
            progress(f"Pose {name} = {v:g} ({k + 1}/{len(values)})", done=k, total=len(values))
            moving, errors = [], []
            for rel in scripts:
                res = load_source(rel, lb["project_dir"], lb["cache_dir"], lb.get("quality") or "normal", lambda *a, **kw: None, {name: v})
                if res.error:
                    errors.append(f"{rel}: {res.error['message']}")
                moving += res.parts
            parts = static + moving
            if sel:
                parts = [pt for pt in parts if any(checks.matches(pt, s) for s in sel)]
            items = self._items(parts)
            if rules:
                rep = checks.evaluate(items, rules, near, deadline)
                pairs = rep["pairs"]
                skipped = rep["skipped_pairs"]
                fails = [{"id": r["id"], "kind": r["kind"], "detail": r["detail"]} for r in rep["results"] if r["status"] == "fail"]
            else:
                pairs, skipped = checks.pair_report(items, near, None, cache, deadline)
                fails = []
            inter = [x for x in pairs if x["kind"] == "interference" and not x.get("allowed_by")]
            for x in pairs:
                key = (x["a"], x["b"])
                cur = pair_min.get(key)
                score = x["distance_mm"] - (x["overlap_mm3"] or 0)
                if cur is None or score < cur["score"]:
                    pair_min[key] = {"a": x["a"], "b": x["b"], "a_name": x["a_name"], "b_name": x["b_name"], "score": score,
                                     "min_distance_mm": x["distance_mm"], "max_overlap_mm3": x["overlap_mm3"], "at": v, "kind": x["kind"],
                                     "allowed_by": x.get("allowed_by")}
            poses.append({"value": v, "interferences": len(inter), "worst": inter[0] if inter else (pairs[0] if pairs else None),
                          "rule_failures": fails, "errors": errors, "skipped_pairs": skipped})
        worst_pairs = sorted(pair_min.values(), key=lambda r: r["score"])[:40]
        for r in worst_pairs:
            r.pop("score", None)
        bad = [x["value"] for x in poses if x["interferences"] or x["rule_failures"] or x["errors"]]
        partial = [x["value"] for x in poses if x["skipped_pairs"]]
        return {"param": name, "scripts": scripts, "values": values, "poses_checked": len(poses), "poses": poses,
                "closest_pairs": worst_pairs, "failing_poses": bad, "incomplete_poses": partial, "near_mm": near,
                "requested": {"first": values[0], "last": values[-1], "count": len(values)},
                "seconds": round(time.perf_counter() - t0, 2), "complete": len(poses) == len(values) and not partial,
                "note": "Only the listed values are checked; motion between them is not."}

    def cmd_printability(self, rid, p):
        out = []
        sel = self._select(p.get("ids"))
        self._fresh(sel, "the printability check")
        for part in sel:
            out.append(checks.printability(part, self._shape(part), float(p.get("overhang_deg", 45)), p.get("bed"), float(p.get("nozzle", 0.4))))
        return {"parts": out}

    def cmd_slice(self, rid, p):
        """Analysis slicing with a PrusaSlicer-family CLI. The G-code stays in the cache (it is an
        analysis artefact for a generic profile, not a print file)."""
        part = self._select([p["id"]])[0]
        self._fresh([part], "slicing")
        exe = p.get("slicer")
        if not exe or not shutil.which(exe) and not os.path.exists(exe):
            raise RuntimeError("no slicer found (PrusaSlicer or SuperSlicer); set its path in Settings > Printing")
        out_dir = p["out_dir"]
        os.makedirs(out_dir, exist_ok=True)
        stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", part.name)[:60] or "part"
        stl = os.path.join(out_dir, stem + ".stl")
        shape = self._shape(part)
        # Bed = lowest Z: put the part on the bed as placed.
        bb = shape.bounding_box()
        bd.export_stl(shape.moved(bd.Location(bd.Vector(0, 0, -bb.min.Z))), stl)
        prof = p.get("profile") or {}
        bed = prof.get("bed") or [220, 220, 250]
        support = bool(p.get("support"))
        ini = {
            "nozzle_diameter": prof.get("nozzle", 0.4), "filament_diameter": prof.get("filament", 1.75),
            "layer_height": prof.get("layer", 0.2), "first_layer_height": prof.get("layer", 0.2),
            "perimeters": prof.get("perimeters", 3), "top_solid_layers": 4, "bottom_solid_layers": 4,
            "fill_density": f"{prof.get('infill', 15)}%", "fill_pattern": "gyroid",
            "support_material": 1 if support else 0, "support_material_auto": 1,
            "support_material_threshold": int(prof.get("overhang", 45)) if support else 0,
            "support_material_contact_distance": 0.2,
            "bed_shape": f"0x0,{bed[0]}x0,{bed[0]}x{bed[1]},0x{bed[1]}", "max_print_height": bed[2],
            "gcode_flavor": "marlin2", "skirts": 1, "brim_width": prof.get("brim", 0),
            "temperature": 210, "first_layer_temperature": 215, "bed_temperature": 60, "first_layer_bed_temperature": 60,
        }
        ini_path = os.path.join(out_dir, "analysis-profile.ini")
        with open(ini_path, "w") as f:
            f.write("".join(f"{k} = {v}\n" for k, v in ini.items()))
        gcode = os.path.join(out_dir, stem + ("-support" if support else "-nosupport") + ".gcode")
        cmd = [exe, "--load", ini_path, "--export-gcode", "--output", gcode, stl]
        env = {k: v for k, v in os.environ.items() if k not in ("ELECTRON_RUN_AS_NODE",)}
        t0 = time.perf_counter()
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=float(p.get("timeout", 300)), env=env)
        log = (r.stdout + r.stderr)[-6000:]
        if r.returncode != 0 or not os.path.exists(gcode):
            raise RuntimeError(f"slicer failed (exit {r.returncode}): {log[-1500:]}")
        data = checks.read_gcode(gcode)
        warnings = [ln.strip() for ln in log.splitlines() if re.search(r"warn|issue|stabil|bridge|overhang|empty layer", ln, re.I)][:20]
        return {"id": part.id, "name": part.name, "support": support, "slicer": os.path.basename(exe), "seconds": round(time.perf_counter() - t0, 1),
                "warnings": warnings, "gcode": gcode, **data,
                "note": "Generic analysis profile; the G-code is not meant for your printer. Slice the exported part with your own profile."}
