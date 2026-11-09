"""Command handlers. State lives here between builds: last parts, keys and shapes."""
from __future__ import annotations

import os
import time

import build123d as bd

from .mesh import tessellate, write_smsh
from .sources import SUPPORTED, load_source


def _bbox(shape) -> list:
    bb = shape.bounding_box()
    return [[bb.min.X, bb.min.Y, bb.min.Z], [bb.max.X, bb.max.Y, bb.max.Z]]


class Worker:
    def __init__(self, send):
        self.send = send
        self.parts: dict = {}      # id -> Part (last successful build)
        self.prev_keys: dict = {}  # id -> mesh key

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
        t0 = time.perf_counter()
        out_parts, sources, new_parts = [], [], {}
        for rel in p.get("sources", []):
            if not rel.lower().endswith(SUPPORTED):
                continue
            res = load_source(rel, project_dir, cache_dir, quality, progress)
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
                    "color": part.color, "mesh": mesh_path, "bbox": _bbox(part.shape),
                    "changed": self.prev_keys.get(part.id) != part.key,
                })
        # Keep previous geometry for sources that failed, so the view does not go blank.
        failed = {s["source"] for s in sources if s["error"]}
        for pid, part in self.parts.items():
            if part.source in failed and pid not in new_parts:
                new_parts[pid] = part
                out_parts.append({"id": pid, "name": part.name, "source": part.source, "key": part.key,
                                  "color": part.color, "mesh": os.path.join(mesh_dir, part.key + ".smsh"),
                                  "bbox": _bbox(part.shape), "changed": False, "stale": True})
        removed = [pid for pid in self.prev_keys if pid not in new_parts]
        self.parts = new_parts
        self.prev_keys = {pid: pt.key for pid, pt in new_parts.items()}
        return {"parts": out_parts, "sources": sources, "removed": removed,
                "seconds": round(time.perf_counter() - t0, 3), "quality": quality}

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
            s = part.shape
            valid = s.is_valid() if callable(getattr(s, "is_valid", None)) else bool(getattr(s, "is_valid", True))
            info = {"id": part.id, "name": part.name, "source": part.source, "bbox": _bbox(s), "valid": valid,
                    "solids": len(s.solids()), "faces": len(s.faces()), "edges": len(s.edges())}
            try:
                info["volume_mm3"] = round(s.volume, 4)
                info["area_mm2"] = round(s.area, 4)
                c = s.center(bd.CenterOf.MASS) if info["volume_mm3"] > 0 else s.center()
                info["center_of_mass"] = [round(c.X, 4), round(c.Y, 4), round(c.Z, 4)]
            except Exception as e:  # noqa: BLE001
                info["properties_error"] = str(e)
            out.append(info)
        return {"parts": out}

    def cmd_face_info(self, rid, p):
        """Describe one B-rep face. Face indices match the mesh face ranges (TopExp order)."""
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus

        part = self._select([p["id"]])[0]
        faces = part.shape.faces()
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
        d = a.shape.distance_to(b.shape)
        inter = 0.0
        try:
            common = a.shape.intersect(b.shape)
            inter = common.volume if common is not None else 0.0
        except Exception:  # noqa: BLE001
            inter = None
        return {"a": a.id, "b": b.id, "min_distance_mm": round(d, 5),
                "intersection_volume_mm3": None if inter is None else round(inter, 5)}

    def cmd_export(self, rid, p):
        parts = self._select(p.get("ids"))
        fmt = p.get("format", "step").lower()
        path = p["path"]
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        shapes = []
        for part in parts:
            s = part.shape
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
        else:
            raise ValueError(f"unknown format {fmt}")
        return {"path": path, "bytes": os.path.getsize(path), "parts": len(parts)}
