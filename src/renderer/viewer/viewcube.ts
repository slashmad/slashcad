// ViewCube: orientation cube in the top-right corner. Click a face, edge or corner to view from there.
import * as THREE from "three";

const DIRS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
const NAMES: Record<string, string[]> = {
  en: ["RIGHT", "LEFT", "BACK", "FRONT", "TOP", "BOTTOM"],
  sv: ["HÖGER", "VÄNSTER", "BAK", "FRAM", "TOPP", "BOTTEN"],
};
const LABELS: [THREE.Vector3, string][] = DIRS.map((d, i) => [d, NAMES.en[i]]);

function labelTexture(text: string, rotate = 0): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#6a7480");
  grad.addColorStop(1, "#525a66");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#9aa5b4";
  g.lineWidth = 6;
  g.strokeRect(3, 3, 250, 250);
  g.translate(128, 128);
  g.rotate(rotate);
  g.fillStyle = "#f2f5f9";
  g.font = `600 ${text.length > 5 ? 40 : 46}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 0, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ViewCube {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  readonly size = 118;
  private cube: THREE.Object3D;
  private faces!: THREE.Group;

  /** Face labels in the UI language (English by default). */
  setLanguage(lang: string): void {
    const names = NAMES[lang] ?? NAMES.en;
    this.faces.children.forEach((m, i) => {
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = labelTexture(names[i]);
      mat.needsUpdate = true;
    });
  }
  private hover: THREE.Mesh;
  private ray = new THREE.Raycaster();
  hoverDir: THREE.Vector3 | null = null;

  constructor() {
    // Six planes, each oriented with an explicit right/up basis so labels read correctly with Z up.
    const faces = new THREE.Group();
    this.faces = faces;
    for (const [n, label] of LABELS) {
      const up = Math.abs(n.z) > 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, n);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: labelTexture(label) }));
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(right, up, n).setPosition(n.clone().multiplyScalar(0.5));
      m.updateMatrixWorld(true);
      faces.add(m);
    }
    this.cube = faces as unknown as THREE.Mesh;
    this.scene.add(faces);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x9aa5b4 }));
    this.scene.add(edges);
    // Axes from the (-,-,-) corner like most CAD tools: X red, Y green, Z blue.
    const o = new THREE.Vector3(-0.5, -0.5, -0.5);
    const axis = (d: THREE.Vector3, c: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(d, 1.25)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, depthTest: false })));
    };
    axis(new THREE.Vector3(1, 0, 0), 0xd23b3b);
    axis(new THREE.Vector3(0, 1, 0), 0x2f9e44);
    axis(new THREE.Vector3(0, 0, 1), 0x2b6fd6);
    this.hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.45, depthTest: false }));
    this.hover.visible = false;
    this.scene.add(this.hover);
  }

  sync(main: THREE.Camera, target: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(main.position, target).normalize();
    this.camera.position.copy(dir.multiplyScalar(3));
    this.camera.up.copy(main.up);
    this.camera.lookAt(0, 0, 0);
    const s = 0.95;
    this.camera.left = -s; this.camera.right = s; this.camera.top = s; this.camera.bottom = -s;
    this.camera.updateProjectionMatrix();
  }

  /** Direction (from target towards camera) for a pointer in cube-local NDC, or null. */
  pick(ndc: THREE.Vector2): THREE.Vector3 | null {
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.cube, true)[0];
    if (!hit) return null;
    const p = hit.point;
    const t = 0.32;
    const d = new THREE.Vector3(Math.abs(p.x) > t ? Math.sign(p.x) : 0, Math.abs(p.y) > t ? Math.sign(p.y) : 0, Math.abs(p.z) > t ? Math.sign(p.z) : 0);
    if (d.lengthSq() === 0) d.set(Math.round(p.x * 2), Math.round(p.y * 2), Math.round(p.z * 2));
    return d;
  }

  setHover(dir: THREE.Vector3 | null): boolean {
    const same = (dir && this.hoverDir && dir.equals(this.hoverDir)) || (!dir && !this.hoverDir);
    this.hoverDir = dir?.clone() ?? null;
    if (!dir) { this.hover.visible = false; return !same; }
    // Region box: thin slab for faces, bar for edges, small cube for corners.
    const sz = (c: number) => (c === 0 ? 0.64 : 0.2);
    this.hover.scale.set(sz(dir.x), sz(dir.y), sz(dir.z));
    this.hover.position.set(dir.x * (0.5 - sz(dir.x) / 2 + 0.01), dir.y * (0.5 - sz(dir.y) / 2 + 0.01), dir.z * (0.5 - sz(dir.z) / 2 + 0.01));
    this.hover.visible = true;
    return !same;
  }
}
