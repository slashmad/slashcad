"""Tessellate a B-rep shape into one merged mesh per part, plus true B-rep edges.

OpenCascade's own glTF writer does the (parallel, C++) meshing and serialisation;
the GLB is then parsed with numpy. Each B-rep face is one glTF primitive, which gives
us face ids for picking and face boundaries (= B-rep edges) for line rendering.
"""
from __future__ import annotations

import json
import os
import struct
import tempfile

import numpy as np
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Message import Message_ProgressRange
from OCP.RWGltf import RWGltf_CafWriter
from OCP.RWMesh import RWMesh_CoordinateSystem_Zup
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool

MAGIC = b"SMSH"
FORMAT_VERSION = 1

_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_DTYPES = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


def deflection_for(diagonal: float, quality: str = "normal") -> tuple[float, float]:
    """Linear (mm) and angular (rad) deflection scaled to part size."""
    scale = {"draft": 3.0, "normal": 1.0, "fine": 0.35}.get(quality, 1.0)
    lin = min(max(diagonal * 0.0008, 0.004), 0.5) * scale
    ang = 0.35 if quality == "draft" else 0.22 if quality == "normal" else 0.12
    return lin, ang


def _write_glb(shape, path: str, lin: float, ang: float) -> None:
    BRepMesh_IncrementalMesh(shape, lin, False, ang, True)
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()).AddShape(shape, False)
    writer = RWGltf_CafWriter(TCollection_AsciiString(path), True)
    conv = writer.ChangeCoordinateSystemConverter()
    # Keep CAD units (mm) and Z-up: no glTF metre/Y-up conversion.
    conv.SetInputLengthUnit(0.001)
    conv.SetOutputLengthUnit(0.001)
    conv.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup)
    conv.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_Zup)
    writer.SetMergeFaces(False)
    writer.SetParallel(True)
    if not writer.Perform(doc, IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString(), Message_ProgressRange()):
        raise RuntimeError("OpenCascade glTF writer failed")


def _node_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in node:
        m = np.diag([*node["scale"], 1.0]) @ m
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
        rm = np.eye(4)
        rm[:3, :3] = r
        m = rm @ m
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = t @ m
    return m


def _read_glb(path: str):
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a GLB")
    off = 12
    doc, binchunk = None, b""
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            doc = json.loads(chunk)
        elif ctype == 0x004E4942:
            binchunk = chunk
        off += 8 + clen
    return doc, binchunk


def _accessor(doc, binchunk, idx):
    acc = doc["accessors"][idx]
    view = doc["bufferViews"][acc["bufferView"]]
    dtype = _DTYPES[acc["componentType"]]
    comps = _COMPONENTS[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride")
    count = acc["count"]
    itemsize = np.dtype(dtype).itemsize * comps
    if stride and stride != itemsize:
        raw = np.frombuffer(binchunk, dtype=np.uint8, count=stride * (count - 1) + itemsize, offset=start)
        rows = np.lib.stride_tricks.as_strided(raw, shape=(count, itemsize), strides=(stride, 1))
        return np.frombuffer(rows.copy().tobytes(), dtype=dtype).reshape(count, comps)
    return np.frombuffer(binchunk, dtype=dtype, count=count * comps, offset=start).reshape(count, comps)


def tessellate(shape, quality: str = "normal") -> dict:
    """Return merged arrays for one part: positions, normals, indices, face_starts, edges."""
    bb = shape.bounding_box()
    diag = float(bb.diagonal) if bb.diagonal else 1.0
    lin, ang = deflection_for(diag, quality)
    fd, path = tempfile.mkstemp(suffix=".glb", prefix="smsh-")
    os.close(fd)
    try:
        _write_glb(shape.wrapped, path, lin, ang)
        doc, binchunk = _read_glb(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    positions, normals, indices, face_starts = [], [], [], []
    vbase = 0
    tbase = 0
    nodes = doc.get("nodes", [])

    def visit(ni, parent):
        nonlocal vbase, tbase
        node = nodes[ni]
        m = parent @ _node_matrix(node)
        if "mesh" in node:
            for prim in doc["meshes"][node["mesh"]]["primitives"]:
                if prim.get("mode", 4) != 4:
                    continue
                pos = _accessor(doc, binchunk, prim["attributes"]["POSITION"]).astype(np.float64)
                pos = pos @ m[:3, :3].T + m[:3, 3]
                if "NORMAL" in prim["attributes"]:
                    nrm = _accessor(doc, binchunk, prim["attributes"]["NORMAL"]).astype(np.float64) @ m[:3, :3].T
                    lens = np.linalg.norm(nrm, axis=1, keepdims=True)
                    nrm = nrm / np.where(lens == 0, 1, lens)
                else:
                    nrm = np.zeros_like(pos)
                if "indices" in prim:
                    idx = _accessor(doc, binchunk, prim["indices"]).reshape(-1).astype(np.uint32)
                else:
                    idx = np.arange(len(pos), dtype=np.uint32)
                face_starts.append(tbase)
                positions.append(pos.astype(np.float32))
                normals.append(nrm.astype(np.float32))
                indices.append(idx + vbase)
                vbase += len(pos)
                tbase += len(idx) // 3
        for c in node.get("children", []):
            visit(c, m)

    for scene in doc.get("scenes", [{"nodes": list(range(len(nodes)))}]):
        for ni in scene.get("nodes", []):
            visit(ni, np.eye(4))

    if not positions:
        empty = np.zeros((0, 3), np.float32)
        return {"positions": empty, "normals": empty, "indices": np.zeros(0, np.uint32),
                "face_starts": np.zeros(0, np.uint32), "edges": np.zeros((0, 2, 3), np.float32),
                "deflection": [lin, ang]}

    P = np.concatenate(positions)
    N = np.concatenate(normals)
    I = np.concatenate(indices)
    F = np.array(face_starts, dtype=np.uint32)
    return {"positions": P, "normals": N, "indices": I, "face_starts": F,
            "edges": _brep_edges(P, I.reshape(-1, 3), F, diag), "deflection": [lin, ang]}


def _brep_edges(P: np.ndarray, T: np.ndarray, face_starts: np.ndarray, diag: float) -> np.ndarray:
    """Face-boundary segments with seams removed and shared edges deduplicated."""
    if len(T) == 0:
        return np.zeros((0, 2, 3), np.float32)
    tri_face = np.zeros(len(T), dtype=np.int64)
    tri_face[face_starts[1:]] = 1
    tri_face = np.cumsum(tri_face)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    ef = np.concatenate([tri_face, tri_face, tri_face])
    e.sort(axis=1)
    # Boundary of each face triangulation = edges used by exactly one triangle.
    _, inv, cnt = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    boundary = cnt[inv.reshape(-1)] == 1
    e, ef = e[boundary], ef[boundary]
    if len(e) == 0:
        return np.zeros((0, 2, 3), np.float32)
    # Positional ids: seams duplicate nodes at the same 3D location inside one face.
    q = np.round(P / max(diag * 1e-6, 1e-9)).astype(np.int64)
    _, pid = np.unique(q, axis=0, return_inverse=True)
    pid = pid.reshape(-1)
    pe = np.sort(pid[e], axis=1)
    key = np.column_stack([ef, pe])
    _, kinv, kcnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    not_seam = kcnt[kinv.reshape(-1)] == 1
    e, pe = e[not_seam], pe[not_seam]
    nondegenerate = pe[:, 0] != pe[:, 1]
    e, pe = e[nondegenerate], pe[nondegenerate]
    if len(e) == 0:
        return np.zeros((0, 2, 3), np.float32)
    # Shared B-rep edges appear once per adjacent face; keep one copy.
    _, first = np.unique(pe, axis=0, return_index=True)
    e = e[np.sort(first)]
    return P[e].astype(np.float32)


def write_smsh(path: str, mesh: dict, meta: dict) -> int:
    """Binary container: MAGIC, u32 header length, JSON header, 8-byte aligned buffers."""
    buffers = [
        ("positions", mesh["positions"].astype(np.float32, copy=False)),
        ("normals", mesh["normals"].astype(np.float32, copy=False)),
        ("indices", mesh["indices"].astype(np.uint32, copy=False)),
        ("face_starts", mesh["face_starts"].astype(np.uint32, copy=False)),
        ("edges", mesh["edges"].astype(np.float32, copy=False)),
    ]
    layout, offset = {}, 0
    for name, arr in buffers:
        layout[name] = {"offset": offset, "length": int(arr.size)}
        offset += arr.nbytes
        offset += (-offset) % 8
    header = json.dumps({"version": FORMAT_VERSION, "meta": meta, "buffers": layout}).encode()
    header += b" " * ((-(len(header) + 8)) % 8)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        for _name, arr in buffers:
            b = arr.tobytes()
            f.write(b)
            f.write(b"\0" * ((-len(b)) % 8))
    os.replace(tmp, path)
    return os.path.getsize(path)
