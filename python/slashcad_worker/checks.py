"""Design checks: pair clearances and interferences, rule evaluation (rules file), pose sweeps,
retention and assembly-path tests, printability and mass properties.

Everything here works on exact B-rep shapes in the placed frame (user placements applied).
Bounding boxes filter pairs first, so large assemblies stay affordable.
"""
from __future__ import annotations

import fnmatch
import math
import time

import build123d as bd
import numpy as np

# Volumes below this (mm³) count as touching, not as interference: boolean noise on coincident faces.
VOLUME_TOL = 1e-3

# Densities in g/cm³ and display colours for common materials. A project's rules file can add or override.
MATERIALS = {
    "pla": {"density": 1.24, "color": "#e8e4d8", "label": "PLA"},
    "petg": {"density": 1.27, "color": "#9fc4d6", "label": "PETG"},
    "abs": {"density": 1.04, "color": "#d8d2c4", "label": "ABS"},
    "asa": {"density": 1.07, "color": "#3a3d42", "label": "ASA"},
    "tpu": {"density": 1.21, "color": "#2f3136", "label": "TPU"},
    "pa": {"density": 1.14, "color": "#d9d4c6", "label": "PA (nylon)"},
    "pc": {"density": 1.20, "color": "#cfd8dc", "label": "PC"},
    "pom": {"density": 1.41, "color": "#f2f0ea", "label": "POM"},
    "aluminium": {"density": 2.70, "color": "#b9bec6", "label": "Aluminium"},
    "steel": {"density": 7.85, "color": "#8e969f", "label": "Steel"},
    "stainless": {"density": 8.00, "color": "#a8b2be", "label": "Stainless steel"},
    "brass": {"density": 8.50, "color": "#c9a84f", "label": "Brass"},
    "copper": {"density": 8.96, "color": "#c8794a", "label": "Copper"},
    "fr4": {"density": 1.85, "color": "#2d8769", "label": "PCB (FR-4)"},
    "rubber": {"density": 1.15, "color": "#26282c", "label": "Rubber / elastomer"},
    "glass": {"density": 2.50, "color": "#bfe3ec", "label": "Glass"},
    "wood": {"density": 0.60, "color": "#b98a5a", "label": "Wood"},
}
ALIASES = {"aluminum": "aluminium", "nylon": "pa", "pa12": "pa", "pcb": "fr4", "ss": "stainless", "elastomer": "rubber"}


def material_table(extra: dict | None) -> dict:
    t = {k: dict(v) for k, v in MATERIALS.items()}
    for k, v in (extra or {}).items():
        key = str(k).lower()
        t[key] = {**t.get(key, {}), **(v or {})}
    return t


def material_info(name, table: dict) -> dict | None:
    if not name:
        return None
    key = str(name).lower().strip()
    key = ALIASES.get(key, key)
    return table.get(key)


# ---------------------------------------------------------------- matching


def matches(part, pattern) -> bool:
    """Glob on the part name or full id; a list matches any of its patterns."""
    if pattern is None:
        return True
    pats = pattern if isinstance(pattern, list) else [pattern]
    return any(fnmatch.fnmatchcase(part.name, str(p)) or fnmatch.fnmatchcase(part.id, str(p)) or part.id == p for p in pats)


def _box(shape):
    bb = shape.bounding_box()
    return np.array([bb.min.X, bb.min.Y, bb.min.Z]), np.array([bb.max.X, bb.max.Y, bb.max.Z])


def _box_gap(a, b) -> float:
    """Distance between two axis-aligned boxes (0 when they overlap)."""
    d = np.maximum(0.0, np.maximum(a[0] - b[1], b[0] - a[1]))
    return float(np.linalg.norm(d))


def overlap_volume(sa, sb) -> float | None:
    """Volume of the common part (mm³), or None when OpenCascade cannot compute it."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    try:
        op = BRepAlgoAPI_Common(sa.wrapped, sb.wrapped)
        op.Build()
        if not op.IsDone():
            return None
        g = GProp_GProps()
        BRepGProp.VolumeProperties_s(op.Shape(), g)
        return max(0.0, float(g.Mass()))
    except Exception:  # noqa: BLE001
        return None


_FACE_BOXES: dict = {}


def _face_boxes(shape):
    """(faces, Nx6 array of face bounding boxes) per shape, cached by identity for one check run."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    key = id(shape.wrapped)
    hit = _FACE_BOXES.get(key)
    if hit is not None and hit[0] is shape.wrapped:
        return hit[1], hit[2]
    faces, boxes = [], []
    ex = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while ex.More():
        f = ex.Current()
        bb = Bnd_Box()
        BRepBndLib.Add_s(f, bb, False)
        if not bb.IsVoid():
            lo, hi = bb.CornerMin(), bb.CornerMax()
            faces.append(f)
            boxes.append((lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()))
        ex.Next()
    arr = np.array(boxes, dtype=float).reshape(-1, 6)
    if len(_FACE_BOXES) > 4000:
        _FACE_BOXES.clear()
    _FACE_BOXES[key] = (shape.wrapped, faces, arr)
    return faces, arr


def _near_faces(shape, other_box, margin):
    faces, arr = _face_boxes(shape)
    if not len(arr):
        return []
    lo, hi = other_box[0] - margin, other_box[1] + margin
    keep = np.all(arr[:, 0:3] <= hi, axis=1) & np.all(arr[:, 3:6] >= lo, axis=1)
    return [faces[i] for i in np.nonzero(keep)[0]]


def _compound(faces):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    c = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(c)
    for f in faces:
        b.Add(c, f)
    return c


def _inside(sa, sb) -> bool:
    """True when a vertex of sa lies inside solid sb (catches a part fully buried in another)."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    vs = sa.vertices()
    if not vs or not sb.solids():
        return False
    v = vs[0]
    for solid in sb.solids():
        cl = BRepClass3d_SolidClassifier(solid.wrapped, gp_Pnt(v.X, v.Y, v.Z), 1e-6)
        if cl.State() == TopAbs_IN:
            return True
    return False


def fast_distance(sa, sb, near: float) -> float:
    """Exact minimum distance between the surfaces of two shapes when it is within `near`;
    a value above `near` otherwise. Only faces whose boxes come within `near` of the other
    shape's box take part, which makes touching contacts between detailed parts fast."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    ba, bb = _box(sa), _box(sb)
    fa = _near_faces(sa, bb, near)
    fb = _near_faces(sb, ba, near)
    if not fa or not fb:
        return near + max(_box_gap(ba, bb), 1.0)
    ext = BRepExtrema_DistShapeShape(_compound(fa), _compound(fb))
    if not ext.IsDone() or ext.NbSolution() == 0:
        return float(sa.distance_to(sb))
    return float(ext.Value())


def pair_metrics(sa, sb, near: float = 0.5) -> dict:
    d = fast_distance(sa, sb, near)
    vol = 0.0
    if d <= 1e-6:
        vol = overlap_volume(sa, sb)
    else:
        # No surfaces meet: still interfering if one part sits wholly inside the other.
        ba, bb = _box(sa), _box(sb)
        a_in_b = bool(np.all(ba[0] >= bb[0]) and np.all(ba[1] <= bb[1]))
        b_in_a = bool(np.all(bb[0] >= ba[0]) and np.all(bb[1] <= ba[1]))
        if (a_in_b and _inside(sa, sb)) or (b_in_a and _inside(sb, sa)):
            d = 0.0
            vol = overlap_volume(sa, sb)
    return {"distance": round(d, 5), "overlap_mm3": None if vol is None else round(vol, 5)}


def pair_report(items, near: float, allowed=None, cache=None, deadline=None):
    """items: list of (part, shape, fingerprint). Returns pairs closer than `near` (incl. overlaps).
    allowed(a, b) -> rule id or None for intended contacts. cache: dict reused between poses."""
    boxes = [(_box(s)) for _, s, _ in items]
    out, skipped = [], 0
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if _box_gap(boxes[i], boxes[j]) > near:
                continue
            if deadline and time.monotonic() > deadline:
                skipped += 1
                continue
            pa, sa, fa = items[i]
            pb, sb, fb = items[j]
            ck = (fa, fb) if fa <= fb else (fb, fa)
            if cache is not None and ck in cache:
                m = cache[ck]
            else:
                m = pair_metrics(sa, sb, near)
                if cache is not None:
                    cache[ck] = m
            if m["distance"] > near:
                continue
            ov = m["overlap_mm3"]
            kind = "interference" if (ov is None or ov > VOLUME_TOL) and m["distance"] <= 1e-6 else ("touch" if m["distance"] <= 1e-6 else "near")
            rule = allowed(pa, pb) if allowed else None
            out.append({"a": pa.id, "b": pb.id, "a_name": pa.name, "b_name": pb.name, "kind": kind,
                        "distance_mm": m["distance"], "overlap_mm3": ov, "allowed_by": rule})
    out.sort(key=lambda r: (r["kind"] != "interference", r["distance_mm"], -(r["overlap_mm3"] or 0)))
    return out, skipped


# ---------------------------------------------------------------- moving tests


def _moved(shape, vec):
    return shape.moved(bd.Location(bd.Vector(*vec)))


def _unit(v):
    v = np.array(v, dtype=float)
    n = np.linalg.norm(v)
    if n == 0:
        raise ValueError("direction must not be zero")
    return v / n


def travel_until_collision(shape, targets, direction, distance: float, step: float):
    """Move `shape` along `direction` in steps; the first travel (mm) at which it overlaps a target,
    or None if it stays free for the whole distance. Returns (travel, target_part_id)."""
    u = _unit(direction)
    n = max(1, int(math.ceil(distance / max(step, 1e-3))))
    for k in range(1, n + 1):
        d = min(distance, k * step)
        moved = _moved(shape, u * d)
        mb = _box(moved)
        for tp, ts in targets:
            if _box_gap(mb, _box(ts)) > 0:
                continue
            v = overlap_volume(moved, ts)
            if v is None or v > VOLUME_TOL:
                return d, tp.id
    return None, None


# ---------------------------------------------------------------- rules


RULE_KINDS = ("interference", "allow_contact", "clearance", "envelope", "protected", "retained", "path_clear")


def evaluate(items, rules: list, near: float = 0.5, deadline=None) -> dict:
    """items: list of (part, shape, fingerprint). rules: list of dicts (see RULE_KINDS)."""
    t0 = time.perf_counter()
    contacts = [r for r in rules if r.get("kind") == "allow_contact"]

    def allowed(pa, pb):
        for r in contacts:
            if (matches(pa, r.get("a")) and matches(pb, r.get("b"))) or (matches(pb, r.get("a")) and matches(pa, r.get("b"))):
                return r.get("id") or "allow_contact"
        return None

    near_eff = near
    interference_on = not any(r.get("kind") == "interference" and r.get("enabled") is False for r in rules)
    pairs, skipped = pair_report(items, near_eff, allowed, deadline=deadline)
    results = []
    if interference_on:
        bad = [p for p in pairs if p["kind"] == "interference" and not p["allowed_by"]]
        results.append({"id": "interference", "kind": "interference", "status": "fail" if bad else "pass",
                        "detail": (f"{len(bad)} interfering pair(s)" if bad else "no unintended interference")
                        + (f"; {skipped} pair(s) not checked (time limit)" if skipped else ""),
                        "pairs": bad[:50], "parts": sorted({x for p in bad for x in (p["a"], p["b"])})[:100]})
    by_id = {p.id: (p, s) for p, s, _ in items}
    for r in rules:
        kind = r.get("kind")
        rid = r.get("id") or kind
        try:
            if kind == "clearance":
                need = float(r.get("min", 0))
                reach = need + 5.0
                A = [(p, s) for p, s, _ in items if matches(p, r.get("a"))]
                B = [(p, s) for p, s, _ in items if matches(p, r.get("b"))]
                if not A or not B:
                    results.append({"id": rid, "kind": kind, "status": "warn", "detail": "no matching parts", "rule": r})
                    continue
                worst = None
                seen = set()
                for pa, sa in A:
                    for pb, sb in B:
                        key = tuple(sorted((pa.id, pb.id)))
                        if pa.id == pb.id or key in seen:
                            continue
                        seen.add(key)
                        if _box_gap(_box(sa), _box(sb)) > reach:
                            continue
                        m = pair_metrics(sa, sb, reach)
                        score = m["distance"] - (m["overlap_mm3"] or 0)
                        if worst is None or score < worst[0]:
                            worst = (score, pa, pb, m)
                if worst is None or worst[3]["distance"] > reach:
                    results.append({"id": rid, "kind": kind, "status": "pass", "detail": f"all pairs are more than {reach:g} mm apart (need ≥ {need} mm)", "rule": r})
                else:
                    _, pa, pb, m = worst
                    inter = m["distance"] <= 1e-6 and (m["overlap_mm3"] is None or m["overlap_mm3"] > VOLUME_TOL)
                    ok = m["distance"] >= need and not inter
                    what = (f"overlap {m['overlap_mm3'] if m['overlap_mm3'] is not None else '?'} mm³" if inter else f"{m['distance']} mm")
                    results.append({"id": rid, "kind": kind, "status": "pass" if ok else "fail",
                                    "detail": f"min {what} between {pa.name} and {pb.name} (need ≥ {need} mm)",
                                    "parts": [pa.id, pb.id], "value": m["distance"], "rule": r})
            elif kind == "envelope":
                sel = [(p, s) for p, s, _ in items if matches(p, r.get("parts", "*"))]
                if not sel:
                    results.append({"id": rid, "kind": kind, "status": "warn", "detail": "no matching parts", "rule": r})
                    continue
                lo = np.min([_box(s)[0] for _, s in sel], axis=0)
                hi = np.max([_box(s)[1] for _, s in sel], axis=0)
                size = (hi - lo).round(3).tolist()
                mx = r.get("max") or [None, None, None]
                over = [f"{'XYZ'[i]} {size[i]} > {mx[i]}" for i in range(3) if mx[i] is not None and size[i] > float(mx[i]) + 1e-6]
                results.append({"id": rid, "kind": kind, "status": "fail" if over else "pass",
                                "detail": ("outside the envelope: " + ", ".join(over)) if over else f"size {size[0]} × {size[1]} × {size[2]} mm within {mx}",
                                "value": size, "rule": r})
            elif kind == "protected":
                fps = r.get("fingerprints") or {}
                changed, missing = [], []
                for pid, fp in fps.items():
                    hit = next(((p, f) for p, _, f in items if p.id == pid), None)
                    if hit is None:
                        missing.append(pid)
                    elif hit[1] != fp:
                        changed.append(pid)
                st = "fail" if changed or missing else "pass"
                det = []
                if changed:
                    det.append(f"changed: {', '.join(x.split('#')[-1] for x in changed[:8])}")
                if missing:
                    det.append(f"missing: {', '.join(x.split('#')[-1] for x in missing[:8])}")
                results.append({"id": rid, "kind": kind, "status": st, "detail": "; ".join(det) or f"{len(fps)} protected part(s) unchanged",
                                "parts": changed, "rule": r})
            elif kind in ("retained", "path_clear"):
                movers = [(p, s) for p, s, _ in items if matches(p, r.get("part"))]
                targets_all = [(p, s) for p, s, _ in items if matches(p, r.get("against", "*"))]
                if not movers:
                    results.append({"id": rid, "kind": kind, "status": "warn", "detail": "no matching part", "rule": r})
                    continue
                dirs = r.get("directions") or ([r["direction"]] if r.get("direction") else [[0, 0, 1]])
                dist = float(r.get("within" if kind == "retained" else "distance", 2.0 if kind == "retained" else 10.0))
                step = float(r.get("step", min(0.25, dist / 8) if kind == "retained" else min(0.5, dist / 10)))
                fails, notes = [], []
                for mp, ms in movers:
                    targets = [(p, s) for p, s in targets_all if p.id != mp.id]
                    for d in dirs:
                        travel, hit = travel_until_collision(ms, targets, d, dist + (step if kind == "retained" else 0), step)
                        if kind == "retained":
                            if travel is None or travel > dist + 1e-9:
                                fails.append(f"{mp.name} moves {dist} mm along {d} without being caught")
                            else:
                                notes.append(f"{mp.name} caught after {travel:.2f} mm along {d} by {hit.split('#')[-1]}")
                        else:
                            if travel is not None:
                                fails.append(f"{mp.name} hits {hit.split('#')[-1]} after {travel:.2f} mm along {d}")
                            else:
                                notes.append(f"{mp.name} free for {dist} mm along {d}")
                results.append({"id": rid, "kind": kind, "status": "fail" if fails else "pass",
                                "detail": "; ".join(fails or notes)[:600], "parts": [p.id for p, _ in movers], "rule": r})
        except Exception as e:  # noqa: BLE001
            results.append({"id": rid, "kind": kind, "status": "warn", "detail": f"could not evaluate: {type(e).__name__}: {e}", "rule": r})
    summary = {"fail": sum(r["status"] == "fail" for r in results), "warn": sum(r["status"] == "warn" for r in results),
               "pass": sum(r["status"] == "pass" for r in results)}
    return {"results": results, "pairs": pairs[:200], "pair_count": len(pairs), "summary": summary,
            "parts": len(items), "seconds": round(time.perf_counter() - t0, 3)}


def matches_id(by_id, pid, pattern) -> bool:
    hit = by_id.get(pid)
    return bool(hit) and matches(hit[0], pattern)


# ---------------------------------------------------------------- printability


def _triangles(shape):
    from .mesh import tessellate

    m = tessellate(shape, "draft")
    pos = np.asarray(m["positions"], dtype=np.float64).reshape(-1, 3)
    idx = np.asarray(m["indices"], dtype=np.int64).reshape(-1, 3)
    return pos[idx]  # (n, 3, 3)


def _orient_stats(tri, overhang_deg: float, bed_tol: float = 0.05):
    """Overhang and bed-contact areas for triangles as they lie (Z up, bed at min Z)."""
    e1, e2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    cr = np.cross(e1, e2)
    area2 = np.linalg.norm(cr, axis=1)
    ok = area2 > 1e-12
    n = np.zeros_like(cr)
    n[ok] = cr[ok] / area2[ok, None]
    area = area2 / 2
    zmin = float(tri[:, :, 2].min())
    zmax = float(tri[:, :, 2].max())
    on_bed = (n[:, 2] < -0.985) & (tri[:, :, 2].max(axis=1) <= zmin + bed_tol)
    limit = -math.sin(math.radians(overhang_deg))
    over = (n[:, 2] < limit) & ~on_bed
    # Nearly horizontal down-facing area off the bed: bridges or support roofs.
    flat = (n[:, 2] < -0.985) & ~on_bed
    return {"overhang_mm2": float(area[over].sum()), "flat_down_mm2": float(area[flat].sum()), "bed_contact_mm2": float(area[on_bed].sum()),
            "height_mm": zmax - zmin, "total_mm2": float(area.sum()), "over_mask": over}


ORIENTATIONS = {
    "as placed": np.eye(3),
    "flip (upside down)": np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], dtype=float),
    "on +X side": np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], dtype=float),
    "on -X side": np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=float),
    "on +Y side": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float),
    "on -Y side": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float),
}


def printability(part, shape, overhang_deg: float, bed, nozzle: float = 0.4) -> dict:
    tri = _triangles(shape)
    if not len(tri):
        return {"id": part.id, "name": part.name, "error": "no triangles (not a solid?)"}
    cur = _orient_stats(tri, overhang_deg)
    lo, hi = tri.reshape(-1, 3).min(axis=0), tri.reshape(-1, 3).max(axis=0)
    size = (hi - lo)
    bed = [float(x) for x in (bed or [220, 220, 250])]
    fits = bool(((size[0] <= bed[0] and size[1] <= bed[1]) or (size[1] <= bed[0] and size[0] <= bed[1])) and size[2] <= bed[2])
    alts = []
    for name, R in ORIENTATIONS.items():
        st = cur if name == "as placed" else _orient_stats(tri @ R.T, overhang_deg)
        alts.append({"orientation": name, "overhang_mm2": round(st["overhang_mm2"], 1), "bed_contact_mm2": round(st["bed_contact_mm2"], 1),
                     "height_mm": round(st["height_mm"], 2)})
    best = min(alts, key=lambda a: (round(a["overhang_mm2"], 0), -a["bed_contact_mm2"], a["height_mm"]))
    over_tri = tri[cur["over_mask"]]
    hints = []
    if cur["bed_contact_mm2"] < 25:
        hints.append(f"small first-layer contact ({cur['bed_contact_mm2']:.0f} mm²): use a brim or another orientation")
    if cur["overhang_mm2"] > 1:
        hints.append(f"{cur['overhang_mm2']:.0f} mm² overhang beyond {overhang_deg:.0f}° needs support or a bridge"
                     + (f"; {cur['flat_down_mm2']:.0f} mm² of it is flat (bridges/roofs)" if cur["flat_down_mm2"] > 1 else ""))
    if not fits:
        hints.append(f"does not fit the bed {bed[0]:.0f} × {bed[1]:.0f} × {bed[2]:.0f} mm")
    if best["orientation"] != "as placed" and best["overhang_mm2"] < cur["overhang_mm2"] * 0.7 - 1:
        hints.append(f"'{best['orientation']}' has less overhang ({best['overhang_mm2']:.0f} mm²); use Lay flat on the face that should touch the bed")
    return {
        "id": part.id, "name": part.name, "size_mm": [round(float(x), 2) for x in size], "fits_bed": fits,
        "overhang_mm2": round(cur["overhang_mm2"], 1), "flat_down_mm2": round(cur["flat_down_mm2"], 1),
        "bed_contact_mm2": round(cur["bed_contact_mm2"], 1), "surface_mm2": round(cur["total_mm2"], 1),
        "overhang_z_range": [round(float(over_tri[:, :, 2].min() - lo[2]), 2), round(float(over_tri[:, :, 2].max() - lo[2]), 2)] if len(over_tri) else None,
        "orientations": alts, "best_orientation": best["orientation"], "hints": hints,
        "threshold_deg": overhang_deg, "note": "Geometric estimate from a coarse mesh in the placed orientation (bed = lowest Z). Not a slicer result.",
    }


# ---------------------------------------------------------------- G-code reading (analysis slicing)


def read_gcode(path: str) -> dict:
    """Extrusion per feature type (mm of filament) and the slicer's footer values."""
    rel_e = False
    e_last = 0.0
    debt = 0.0
    kind = "Unknown"
    per: dict = {}
    footer: dict = {}
    layers = 0
    with open(path, errors="replace") as f:
        for line in f:
            if line.startswith(";"):
                if line.startswith(";TYPE:"):
                    kind = line[6:].strip()
                elif line.startswith(";LAYER_CHANGE"):
                    layers += 1
                elif line.startswith("; ") and " = " in line:
                    k, _, v = line[2:].partition(" = ")
                    if k.startswith(("filament used", "estimated printing time", "total filament", "support material")):
                        footer[k.strip()] = v.strip()
                continue
            code = line.split(";", 1)[0].strip()
            if not code:
                continue
            if code.startswith("M83"):
                rel_e = True
            elif code.startswith("M82"):
                rel_e = False
            elif code.startswith("G92"):
                for tok in code.split()[1:]:
                    if tok.startswith("E"):
                        e_last = float(tok[1:] or 0)
            elif code.startswith(("G1", "G0", "G2", "G3")):
                for tok in code.split()[1:]:
                    if tok.startswith("E"):
                        try:
                            e = float(tok[1:])
                        except ValueError:
                            break
                        de = e if rel_e else e - e_last
                        if not rel_e:
                            e_last = e
                        if de < 0:
                            debt -= de  # retraction: the next forward move only primes it back
                        elif de > 0:
                            repay = min(debt, de)
                            debt -= repay
                            if de - repay > 0:
                                per[kind] = per.get(kind, 0.0) + de - repay
                        break
    support = sum(v for k, v in per.items() if "support" in k.lower())
    return {"extrusion_mm_by_type": {k: round(v, 1) for k, v in sorted(per.items(), key=lambda kv: -kv[1])},
            "support_filament_mm": round(support, 1), "total_filament_mm": round(sum(per.values()), 1),
            "layers": layers, "footer": footer}
