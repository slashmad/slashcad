// Parser for the worker's SMSH mesh container (see python/slashcad_worker/mesh.py).
export interface ParsedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceStarts: Uint32Array;
  edges: Float32Array; // segment endpoints, xyz xyz
  bytes: number;
  meta: Record<string, unknown>;
}

export function parseSmsh(data: Uint8Array): ParsedMesh {
  // Typed array views need aligned offsets; copy once if the IPC buffer is not aligned.
  const buf = data.byteOffset % 8 === 0 ? data : data.slice();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== "SMSH") throw new Error("unknown mesh format");
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hlen)));
  const base = buf.byteOffset + 8 + hlen;
  const view = <T>(name: string, Ctor: new (b: ArrayBufferLike, o: number, l: number) => T): T => {
    const b = header.buffers[name];
    return new Ctor(buf.buffer, base + b.offset, b.length);
  };
  return {
    positions: view("positions", Float32Array),
    normals: view("normals", Float32Array),
    indices: view("indices", Uint32Array),
    faceStarts: view("face_starts", Uint32Array),
    edges: view("edges", Float32Array),
    bytes: buf.byteLength,
    meta: header.meta ?? {},
  };
}

/** Face index for a triangle via binary search in faceStarts. */
export function faceOfTriangle(faceStarts: Uint32Array, tri: number): number {
  let lo = 0, hi = faceStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (faceStarts[mid] <= tri) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
