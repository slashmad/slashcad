// Live CAD viewer: renders on demand, never blocks on builds, never resets the user's camera on
// updates. Parts arrive as merged meshes with face ranges and B-rep edges from the worker.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { Annotation, PartInfo, SnapshotRequest, ViewName } from "../../shared/types";
import { Navigation, type NavConfig, type NavTool } from "./navigation";
import { faceOfTriangle, type ParsedMesh } from "./smsh";
import { ViewCube } from "./viewcube";

(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type DisplayMode = "shaded-edges" | "shaded" | "wire" | "xray";
export type SectionAxis = "x" | "y" | "z" | null;
export type TransformMode = "move" | "rotate";

export interface Selection {
  partId: string;
  face: number;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
}

interface PartObj {
  info: PartInfo;
  key: string;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  faceStarts: Uint32Array;
  material: THREE.MeshStandardMaterial;
  bvh: boolean;
  flash: number; // remaining flash time (s)
}

const VIEW_DIRS: Record<Exclude<ViewName, "current">, [THREE.Vector3, THREE.Vector3]> = {
  iso: [new THREE.Vector3(1, -1, 0.85).normalize(), new THREE.Vector3(0, 0, 1)],
  front: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
  back: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  right: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  left: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
  top: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  bottom: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
};

/** GTAO that also ignores overlays (selection/hover highlights, pins, ground shadow plane) in its
 * normal/depth pass; otherwise a transparent highlight is treated as occluding geometry and the
 * AO blend turns it nearly black. */
class CadGTAOPass extends GTAOPass {}
// The JS implementation names it _overrideVisibility (the .d.ts differs), so patch the prototype.
(CadGTAOPass.prototype as any)._overrideVisibility = function (this: GTAOPass) {
  (GTAOPass.prototype as any)._overrideVisibility.call(this);
  const cache = (this as any)._visibilityCache as THREE.Object3D[];
  this.scene.traverse((o) => {
    if (o.visible && (o.userData.noAO || (o as THREE.Sprite).isSprite)) { o.visible = false; cache.push(o); }
  });
};

const DEFAULT_COLOR = new THREE.Color(0x9aa5b8); // neutral blue-grey (sRGB), like most CAD apps
const ACCENT = new THREE.Color(0x3b82f6);

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private cam: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly target = new THREE.Vector3();
  private root = new THREE.Group();
  private ghosts = new THREE.Group();
  private helpers = new THREE.Group();
  private parts = new Map<string, PartObj>();
  private nav: Navigation;
  private cube = new ViewCube();
  private dirty = true;
  private raf = 0;
  private lastT = performance.now();
  private anim: { t: number; dur: number; from: any; to: any } | null = null;
  private ray = new THREE.Raycaster();
  private sectionUniform = { value: 0 };
  private hoverMesh: THREE.Mesh;
  private selectMesh: THREE.Mesh;
  private pivotDot: THREE.Mesh;
  private grid: THREE.Group | null = null;
  private bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
  private hidden = new Set<string>();
  private highlighted = new Set<string>();
  private measurePts: THREE.Vector3[] = [];
  private measureObj = new THREE.Group();
  private measureLabel: HTMLDivElement;
  private ro: ResizeObserver;
  private downPos = new THREE.Vector2();
  private hasFitted = false;
  private pins = new THREE.Group();
  private key = new THREE.DirectionalLight(0xffffff, 0.55);
  private ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32, transparent: true, depthWrite: false }));
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtao: GTAOPass | null = null;
  private idleTimer = 0;
  private aoFresh = false;
  ambientOcclusion = true;
  private pinTextures = new Map<string, THREE.CanvasTexture>();
  theme: "dark" | "light" = "dark";
  mode: DisplayMode = "shaded-edges";
  section: { axis: SectionAxis; offset: number; flip: boolean } = { axis: null, offset: 0.5, flip: false };
  showBefore = false;
  measuring = false;
  selection: Selection | null = null;
  onSelect: (s: Selection | null) => void = () => {};
  onMeasure: (d: { a: THREE.Vector3; b: THREE.Vector3; dist: number } | null) => void = () => {};
  onFrame: (fps: number) => void = () => {};
  onPinClick: (id: string) => void = () => {};
  onContextMenu: (clientX: number, clientY: number, hit: Selection | null) => void = () => {};
  /** The user finished moving/rotating a part: store this placement (null = none). */
  onPlacement: (id: string, matrix: number[] | null) => void = () => {};
  /** A stored placement changed by `delta` (world): pins and other world data on the part follow it. */
  onPlacementDelta: (id: string, delta: THREE.Matrix4) => void = () => {};
  onTransformChange: (t: { mode: TransformMode; id: string } | null) => void = () => {};
  private placements = new Map<string, THREE.Matrix4>(); // committed placements
  private tc: TransformControls | null = null;
  private tcProxy = new THREE.Object3D();
  private tcState: { mode: TransformMode; id: string } | null = null;
  private tcDrag: { p0: THREE.Matrix4; g0: THREE.Matrix4 } | null = null;
  middleDoubleClick: "home" | "fit" | "none" = "home";
  animateViews = true;
  animationSpeed = 1;
  fitSize = 1;
  fitOnViewChange = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.localClippingEnabled = false;
    this.renderer.setClearColor(0x000000, 0);
    // Soft contact shadow from a fixed world light; the map only changes when geometry does.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true; // create the map before anything samples it
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.tabIndex = 0;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.38;
    this.scene.add(new THREE.HemisphereLight(0xe3e9f4, 0x343a46, 0.32));
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target, this.ground);
    this.ground.receiveShadow = true;
    this.ground.userData.noAO = true;
    this.ground.renderOrder = -2;

    this.persp = new THREE.PerspectiveCamera(32, 1, 0.1, 10000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.cam = this.persp;
    // Headlight that follows the camera (slightly above/left of the view axis).
    for (const c of [this.persp, this.ortho]) {
      const head = new THREE.DirectionalLight(0xffffff, 0.95);
      head.position.set(-0.55, 0.75, 0.25); // from the upper left, like a studio key light
      const aim = new THREE.Object3D();
      aim.position.set(0, 0, -1);
      c.add(head, aim);
      head.target = aim;
    }
    this.scene.add(this.persp, this.ortho);

    this.scene.add(this.root, this.ghosts, this.helpers, this.measureObj, this.pins);
    this.ghosts.visible = false;
    this.hoverMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x5b9dff, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    this.selectMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x3d84f5, transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }));
    this.hoverMesh.visible = this.selectMesh.visible = false;
    this.hoverMesh.renderOrder = this.selectMesh.renderOrder = 5;
    this.helpers.userData.noAO = true;
    this.measureObj.userData.noAO = true;
    this.helpers.add(this.hoverMesh, this.selectMesh);
    this.pivotDot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false }));
    this.pivotDot.renderOrder = 10;
    this.pivotDot.visible = false;
    this.helpers.add(this.pivotDot);

    this.measureLabel = document.createElement("div");
    this.measureLabel.className = "measure-label";
    this.measureLabel.style.display = "none";
    container.appendChild(this.measureLabel);

    (this.ray as any).firstHitOnly = true;
    const self = this;
    this.nav = new Navigation({
      camera: () => self.cam,
      target: this.target,
      dom: this.renderer.domElement,
      pickPoint: (x, y) => self.pick(x, y)?.point ?? null,
      changed: () => self.requestRender(),
      setPivotMarker: (p) => {
        self.pivotDot.visible = !!p;
        if (p) self.pivotDot.position.copy(p);
        self.requestRender();
      },
      sceneRadius: () => self.radius(),
      onContextClick: (x, y) => self.onContextMenu(x, y, self.pick(x, y)),
      onMiddleDoubleClick: () => {
        if (self.middleDoubleClick === "home") self.setView("iso", true, true);
        else if (self.middleDoubleClick === "fit") self.fit();
      },
    });

    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", (e) => { this.downPos.set(e.clientX, e.clientY); });
    dom.addEventListener("pointerup", (e) => this.onClick(e));
    dom.addEventListener("pointermove", (e) => this.onHover(e));
    dom.addEventListener("pointerleave", () => { this.hoverMesh.visible = false; this.cube.setHover(null); this.requestRender(); });
    dom.addEventListener("dblclick", (e) => { if (e.button === 0) { const h = this.pick(e.clientX, e.clientY); if (h) this.fit([h.partId]); } });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.setView("iso", false);
    this.loop();
  }

  // ------------------------------------------------------------------ settings
  setNavConfig(cfg: Partial<NavConfig>): void { this.nav.cfg = { ...this.nav.cfg, ...cfg }; }
  setTool(t: NavTool): void {
    this.nav.tool = t;
    this.renderer.domElement.style.cursor = t === "orbit" ? "grab" : t === "pan" ? "move" : t === "zoom" ? "zoom-in" : "default";
  }
  get tool(): NavTool { return this.nav.tool; }

  setLanguage(lang: string): void {
    this.cube.setLanguage(lang);
    this.requestRender();
  }

  setTheme(t: "dark" | "light"): void {
    this.theme = t;
    this.updateGrid();
    this.requestRender();
  }

  // ------------------------------------------------------------------ markers (pins)
  private pinTexture(n: number, done: boolean): THREE.CanvasTexture {
    const key = `${n}-${done}`;
    let t = this.pinTextures.get(key);
    if (t) return t;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.beginPath();
    g.arc(64, 64, 54, 0, Math.PI * 2);
    g.fillStyle = done ? "#2f9e5b" : "#f08c1a";
    g.fill();
    g.lineWidth = 9;
    g.strokeStyle = "#ffffff";
    g.stroke();
    g.fillStyle = "#ffffff";
    g.font = `700 ${n > 99 ? 44 : 60}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(n), 64, 68);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.pinTextures.set(key, t);
    return t;
  }

  setAnnotations(list: Annotation[], activeId?: string | null): void {
    for (const c of [...this.pins.children]) { (c as THREE.Sprite).material.dispose(); }
    this.pins.clear();
    for (const a of list) {
      const m = new THREE.SpriteMaterial({ map: this.pinTexture(a.n, a.status === "done"), depthTest: false, sizeAttenuation: false, toneMapped: false });
      const sp = new THREE.Sprite(m);
      const s = a.id === activeId ? 0.05 : 0.038;
      sp.scale.set(s, s, 1);
      sp.center.set(0.5, 0.0); // sits on the point like a pin head
      sp.position.set(...a.point);
      sp.renderOrder = 30;
      sp.userData.annotationId = a.id;
      this.pins.add(sp);
    }
    this.requestRender();
  }

  private pickPin(clientX: number, clientY: number): string | null {
    if (!this.pins.children.length) return null;
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.cam);
    const hit = this.ray.intersectObjects(this.pins.children, false)[0];
    return hit ? (hit.object.userData.annotationId as string) : null;
  }

  setProjection(kind: "perspective" | "orthographic"): void {
    const from = this.cam;
    const to = kind === "orthographic" ? this.ortho : this.persp;
    if (from === to) return;
    const dir = new THREE.Vector3().subVectors(from.position, this.target).normalize();
    const dist = from.position.distanceTo(this.target);
    if (to === this.ortho) {
      const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      this.ortho.zoom = (this.ortho.top - this.ortho.bottom) / h;
      this.ortho.position.copy(this.target).addScaledVector(dir, Math.max(dist, this.radius() * 4));
    } else {
      const h = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const d = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
      this.persp.position.copy(this.target).addScaledVector(dir, d);
    }
    to.up.copy(from.up);
    to.lookAt(this.target);
    to.updateProjectionMatrix();
    this.cam = to;
    if (this.tc) (this.tc as any).camera = to;
    this.requestRender();
  }

  get projection(): "perspective" | "orthographic" { return this.cam === this.ortho ? "orthographic" : "perspective"; }

  setMode(m: DisplayMode): void {
    this.mode = m;
    this.renderer.shadowMap.needsUpdate = true;
    for (const p of this.parts.values()) this.applyMode(p);
    this.requestRender();
  }

  private applyMode(p: PartObj): void {
    const vis = !this.hidden.has(p.info.id);
    p.mesh.visible = vis && this.mode !== "wire";
    p.edges.visible = vis && this.mode !== "shaded";
    const m = p.material;
    const xray = this.mode === "xray";
    if (m.transparent !== xray) { m.transparent = xray; m.needsUpdate = true; }
    m.opacity = xray ? 0.22 : 1;
    m.depthWrite = !xray;
  }

  setSection(axis: SectionAxis, offset = this.section.offset, flip = this.section.flip): void {
    this.section = { axis, offset, flip };
    this.sectionUniform.value = axis ? 1 : 0;
    if (!axis) {
      this.renderer.clippingPlanes = [];
    } else {
      const i = { x: 0, y: 1, z: 2 }[axis];
      const n = new THREE.Vector3().setComponent(i, flip ? 1 : -1);
      const pos = THREE.MathUtils.lerp(this.bounds.min.getComponent(i), this.bounds.max.getComponent(i), offset);
      this.renderer.clippingPlanes = [new THREE.Plane(n, flip ? -pos : pos)];
    }
    this.requestRender();
  }

  setShowBefore(v: boolean): void {
    this.showBefore = v;
    this.ghosts.visible = v;
    this.requestRender();
  }

  setHidden(ids: Iterable<string>): void {
    this.hidden = new Set(ids);
    this.renderer.shadowMap.needsUpdate = true;
    for (const p of this.parts.values()) this.applyMode(p);
    this.requestRender();
  }

  setMeasuring(on: boolean): void {
    this.measuring = on;
    this.clearMeasure();
  }

  clearMeasure(): void {
    this.measurePts = [];
    this.measureObj.clear();
    this.measureLabel.style.display = "none";
    this.onMeasure(null);
    this.requestRender();
  }

  // ------------------------------------------------------------------ parts
  private makeMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color, metalness: 0.0, roughness: 0.62, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const su = this.sectionUniform;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSection = su;
      sh.fragmentShader = "uniform float uSection;\n" + sh.fragmentShader.replace(
        "#include <dithering_fragment>",
        "#include <dithering_fragment>\n if (uSection > 0.5 && !gl_FrontFacing) { gl_FragColor = vec4(0.86, 0.36, 0.28, 1.0); }",
      );
    };
    return m;
  }

  /**
   * Apply a build. Unchanged parts (same key) are kept as-is; changed parts are swapped in place and
   * flash briefly; the previous version of changed/removed parts becomes the "before" ghost.
   */
  updateParts(parts: PartInfo[], meshes: Map<string, ParsedMesh>, opts: { flash: boolean }): void {
    const keep = new Set(parts.map((p) => p.id));
    const newGhosts: THREE.Object3D[] = [];
    for (const [id, obj] of this.parts) {
      if (!keep.has(id)) { newGhosts.push(this.toGhost(obj)); this.parts.delete(id); }
    }
    for (const info of parts) {
      const mesh = meshes.get(info.key);
      const existing = this.parts.get(info.id);
      if (existing && existing.key === info.key) {
        existing.info = info;
        if (info.color) existing.material.color.setRGB(info.color[0], info.color[1], info.color[2], THREE.SRGBColorSpace);
        continue;
      }
      if (!mesh) continue;
      if (existing) { newGhosts.push(this.toGhost(existing)); this.parts.delete(info.id); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const color = info.color ? new THREE.Color().setRGB(info.color[0], info.color[1], info.color[2], THREE.SRGBColorSpace) : DEFAULT_COLOR.clone();
      const material = this.makeMaterial(color);
      const m = new THREE.Mesh(g, material);
      m.castShadow = true;
      m.userData.partId = info.id;
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
      // Dark edges on light parts, light edges on dark parts (e.g. black STEP bodies).
      const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
      const edgeColor = lum < 0.06 ? new THREE.Color(0x8a94a3) : color.clone().multiplyScalar(0.18);
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.85 }));
      edges.userData.partId = info.id;
      m.matrixAutoUpdate = edges.matrixAutoUpdate = false;
      this.root.add(m, edges);
      const obj: PartObj = { info, key: info.key, mesh: m, edges, faceStarts: mesh.faceStarts, material, bvh: false, flash: opts.flash && info.changed ? 1.6 : 0 };
      this.applyPlacement(obj, this.placements.get(info.id) ?? null);
      this.applyMode(obj);
      this.parts.set(info.id, obj);
    }
    if (newGhosts.length || opts.flash) {
      for (const c of [...this.ghosts.children]) this.disposeObject(c);
      this.ghosts.clear();
      for (const g of newGhosts) this.ghosts.add(g);
    }
    if (this.selection && !this.parts.has(this.selection.partId)) this.select(null);
    if (this.tcState) { const t = this.tcState; this.parts.has(t.id) ? this.startTransform(t.mode, t.id) : this.stopTransform(); }
    this.recomputeBounds();
    if (!this.hasFitted && this.parts.size) {
      this.hasFitted = true;
      this.fit(undefined, false);
    }
    this.scheduleBvh();
    this.requestRender();
  }

  private toGhost(obj: PartObj): THREE.Object3D {
    this.root.remove(obj.mesh, obj.edges);
    obj.material.dispose();
    obj.mesh.material = new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    (obj.edges.material as THREE.Material).dispose();
    obj.edges.material = new THREE.LineBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.55 });
    const g = new THREE.Group();
    g.add(obj.mesh, obj.edges);
    return g;
  }

  private disposeObject(o: THREE.Object3D): void {
    o.traverse((c: any) => {
      c.geometry?.disposeBoundsTree?.();
      c.geometry?.dispose?.();
      const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
      mats.forEach((m: THREE.Material) => m.dispose());
    });
  }

  clear(): void {
    for (const p of this.parts.values()) { this.root.remove(p.mesh, p.edges); this.disposeObject(p.mesh); this.disposeObject(p.edges); }
    this.parts.clear();
    for (const c of [...this.ghosts.children]) this.disposeObject(c);
    this.ghosts.clear();
    this.hasFitted = false;
    this.select(null);
    this.requestRender();
  }

  private bvhQueued = false;
  private scheduleBvh(): void {
    if (this.bvhQueued) return;
    this.bvhQueued = true;
    const step = (deadline?: IdleDeadline) => {
      for (const p of this.parts.values()) {
        if (p.bvh) continue;
        // indirect: three-mesh-bvh would otherwise reorder the index buffer, which breaks the
        // triangle -> B-rep face mapping (faceStarts) used for picking and highlighting.
        (p.mesh.geometry as any).computeBoundsTree({ indirect: true });
        p.bvh = true;
        if (deadline && deadline.timeRemaining() < 4) break;
      }
      if ([...this.parts.values()].some((p) => !p.bvh)) requestIdleCallback(step);
      else this.bvhQueued = false;
    };
    requestIdleCallback(step);
  }

  private recomputeBounds(): void {
    const b = new THREE.Box3();
    for (const p of this.parts.values()) b.union(this.worldBox(p));
    if (b.isEmpty()) return;
    this.bounds.copy(b);
    this.updateGrid();
    this.updateShadow();
    this.tuneAo();
    if (this.section.axis) this.setSection(this.section.axis);
  }

  private updateShadow(): void {
    const c = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 1);
    this.key.position.set(c.x - r * 0.6, c.y - r * 0.9, this.bounds.max.z + r * 2.5);
    this.key.target.position.set(c.x, c.y, this.bounds.min.z);
    const cam = this.key.shadow.camera;
    cam.left = -r * 1.6; cam.right = r * 1.6; cam.top = r * 1.6; cam.bottom = -r * 1.6;
    cam.near = 0.1; cam.far = r * 8 + size.z;
    cam.updateProjectionMatrix();
    this.ground.scale.set(r * 6, r * 6, 1);
    this.ground.position.set(c.x, c.y, this.bounds.min.z - Math.max(r * 0.002, 0.01));
    this.renderer.shadowMap.needsUpdate = true;
  }

  private updateGrid(): void {
    if (this.grid) { this.disposeObject(this.grid); this.scene.remove(this.grid); }
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 10) * 2.2;
    const raw = span / 24;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const cell = [1, 2, 5, 10].map((m) => m * pow).find((c) => c >= raw) ?? raw;
    const divisions = Math.max(4, Math.round(span / cell / 2) * 2);
    const g = new THREE.Group();
    const dark = this.theme === "dark";
    const minor = new THREE.GridHelper(divisions * cell, divisions, dark ? 0x4b5361 : 0x9aa5b4, dark ? 0x323843 : 0xb9c2cd);
    minor.rotation.x = Math.PI / 2;
    (minor.material as THREE.Material).transparent = true;
    (minor.material as THREE.Material).opacity = dark ? 0.7 : 0.45;
    (minor.material as THREE.Material).depthWrite = false;
    g.add(minor);
    const c = this.bounds.getCenter(new THREE.Vector3());
    g.position.set(Math.round(c.x / cell) * cell, Math.round(c.y / cell) * cell, Math.min(0, this.bounds.min.z));
    g.renderOrder = -1;
    g.userData.cell = cell;
    this.grid = g;
    this.scene.add(g);
  }

  radius(): number {
    return Math.max(this.bounds.getSize(new THREE.Vector3()).length() / 2, 1);
  }

  // ------------------------------------------------------------------ views
  private visibleBounds(ids?: string[]): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.parts.values()) {
      if (ids ? !ids.includes(p.info.id) : this.hidden.has(p.info.id)) continue;
      b.union(this.worldBox(p));
    }
    return b.isEmpty() ? this.bounds.clone() : b;
  }

  private camState() {
    const dir = new THREE.Vector3().subVectors(this.cam.position, this.target).normalize();
    return { target: this.target.clone(), dir, up: this.cam.up.clone(), dist: this.cam.position.distanceTo(this.target), zoom: this.ortho.zoom };
  }

  private fitState(dir: THREE.Vector3, up: THREE.Vector3, box: THREE.Box3, aspect = this.aspect()) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = (Math.max(sphere.radius, 0.5) * 1.08) / THREE.MathUtils.clamp(this.fitSize, 0.3, 1);
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
    const dist = r / Math.sin(fit / 2);
    const h = (2 * r) / Math.min(1, aspect);
    return { target: sphere.center.clone(), dir: dir.clone().normalize(), up: up.clone(), dist, zoom: (this.ortho.top - this.ortho.bottom) / h };
  }

  private aspect(): number {
    return (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
  }

  fit(ids?: string[], animate = true): void {
    const s = this.camState();
    this.animateTo(this.fitState(s.dir, s.up, this.visibleBounds(ids)), animate);
  }

  /** View direction from a named view or a ViewCube direction. `forceFit` = Home behaviour. */
  setView(view: Exclude<ViewName, "current"> | THREE.Vector3, animate = true, forceFit = false): void {
    let dir: THREE.Vector3, up: THREE.Vector3;
    if (view instanceof THREE.Vector3) {
      dir = view.clone().normalize();
      if (Math.abs(dir.z) > 0.99) {
        // Looking straight down/up: keep the user's current heading, snapped to an axis.
        const cu = this.cam.up.clone().setZ(0);
        if (cu.lengthSq() < 1e-6) cu.set(0, 1, 0);
        up = Math.abs(cu.x) > Math.abs(cu.y) ? new THREE.Vector3(Math.sign(cu.x), 0, 0) : new THREE.Vector3(0, Math.sign(cu.y) || 1, 0);
      } else up = new THREE.Vector3(0, 0, 1);
    } else [dir, up] = VIEW_DIRS[view];
    if (forceFit || this.fitOnViewChange || !this.hasFitted) {
      this.animateTo(this.fitState(dir, up, this.visibleBounds()), animate);
    } else {
      // Keep the current target and zoom; only turn the camera (navigator behaviour).
      const s = this.camState();
      this.animateTo({ ...s, dir: dir.clone().normalize(), up: up.clone() }, animate);
    }
  }

  private animateTo(to: ReturnType<Viewer["camState"]>, animate: boolean): void {
    if (!animate || !this.animateViews) { this.applyCam(to); this.requestRender(); return; }
    this.anim = { t: 0, dur: 0.42 / THREE.MathUtils.clamp(this.animationSpeed, 0.25, 4), from: this.camState(), to };
    this.requestRender();
  }

  private applyCam(s: ReturnType<Viewer["camState"]>): void {
    this.target.copy(s.target);
    for (const c of [this.persp, this.ortho]) c.up.copy(s.up);
    this.persp.position.copy(s.target).addScaledVector(s.dir, s.dist);
    this.persp.lookAt(s.target);
    this.ortho.position.copy(s.target).addScaledVector(s.dir, Math.max(s.dist, this.radius() * 4));
    this.ortho.zoom = s.zoom;
    this.ortho.lookAt(s.target);
    this.ortho.updateProjectionMatrix();
  }

  private stepAnim(dt: number): void {
    const a = this.anim!;
    a.t = Math.min(1, a.t + dt / a.dur);
    const k = 1 - Math.pow(1 - a.t, 3);
    const qa = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(a.from.dir, new THREE.Vector3(), a.from.up));
    const qb = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(a.to.dir, new THREE.Vector3(), a.to.up));
    const q = qa.slerp(qb, k);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.applyCam({
      target: a.from.target.clone().lerp(a.to.target, k), dir, up,
      dist: THREE.MathUtils.lerp(a.from.dist, a.to.dist, k), zoom: Math.exp(THREE.MathUtils.lerp(Math.log(a.from.zoom), Math.log(a.to.zoom), k)),
    });
    if (a.t >= 1) this.anim = null;
  }

  // ------------------------------------------------------------------ picking
  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  private inCube(clientX: number, clientY: number): THREE.Vector2 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const s = this.cube.size;
    const x = clientX - (r.right - s - 8), y = clientY - (r.top + 8);
    if (x < 0 || y < 0 || x > s || y > s) return null;
    return new THREE.Vector2((x / s) * 2 - 1, -(y / s) * 2 + 1);
  }

  pick(clientX: number, clientY: number): Selection | null {
    const meshes = [...this.parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
    if (!meshes.length) return null;
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.cam);
    const planes = this.renderer.clippingPlanes;
    const hits = this.ray.intersectObjects(meshes, false);
    const hit = hits.find((h) => planes.every((pl) => pl.distanceToPoint(h.point) >= -1e-6));
    if (!hit || hit.faceIndex == null) return null;
    const part = this.parts.get(hit.object.userData.partId)!;
    // Face normals are in the part's own frame; placements rotate them into the world.
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    return { partId: part.info.id, face: faceOfTriangle(part.faceStarts, hit.faceIndex), point: hit.point.clone(), normal };
  }

  private faceGeometry(partId: string, face: number): THREE.BufferGeometry | null {
    const p = this.parts.get(partId);
    if (!p) return null;
    const start = p.faceStarts[face] * 3;
    const end = face + 1 < p.faceStarts.length ? p.faceStarts[face + 1] * 3 : (p.mesh.geometry.index!.count);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", p.mesh.geometry.getAttribute("position"));
    g.setIndex(new THREE.BufferAttribute((p.mesh.geometry.index!.array as Uint32Array).subarray(start, end), 1));
    return g;
  }

  private hoverPending: PointerEvent | null = null;
  private onHover(e: PointerEvent): void {
    this.hoverPending = e;
  }

  private processHover(): void {
    const e = this.hoverPending;
    this.hoverPending = null;
    if (!e || this.nav.busy || this.anim) return;
    const c = this.inCube(e.clientX, e.clientY);
    if (this.cube.setHover(c ? this.cube.pick(c) : null)) this.requestRender();
    if (c) { this.hoverMesh.visible = false; return; }
    const h = this.pick(e.clientX, e.clientY);
    const key = h ? `${h.partId}#${h.face}` : "";
    if (key === this.hoverMesh.userData.key) return;
    this.hoverMesh.userData.key = key;
    this.hoverMesh.geometry = h ? this.faceGeometry(h.partId, h.face) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry();
    this.overlayFollow(this.hoverMesh, h?.partId);
    this.hoverMesh.visible = !!h && !this.measuring;
    this.renderer.domElement.style.cursor = h ? (this.measuring ? "crosshair" : "pointer") : "default";
    this.requestRender();
  }

  private onClick(e: PointerEvent): void {
    if (e.button !== 0 || e.altKey) return;
    if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 4) return;
    const c = this.inCube(e.clientX, e.clientY);
    if (c) {
      const d = this.cube.pick(c);
      if (d) this.setView(d);
      return;
    }
    if (this.nav.tool !== "select") return;
    if (this.tc && ((this.tc as any).dragging || this.tc.axis)) return; // a gizmo handle, not the model
    const pin = this.pickPin(e.clientX, e.clientY);
    if (pin) { this.onPinClick(pin); return; }
    const h = this.pick(e.clientX, e.clientY);
    if (this.measuring) { if (h) this.addMeasurePoint(h.point); return; }
    this.select(h);
  }

  /** Select a whole part (from the model tree): no face highlight. */
  selectPart(id: string): void {
    const p = this.parts.get(id);
    if (!p) return;
    this.select({ partId: id, face: -1, point: this.worldBox(p).getCenter(new THREE.Vector3()), normal: null });
  }

  select(s: Selection | null): void {
    this.selection = s;
    this.selectMesh.visible = !!s && s.face >= 0;
    if (s && s.face >= 0) { this.selectMesh.geometry = this.faceGeometry(s.partId, s.face) ?? new THREE.BufferGeometry(); this.overlayFollow(this.selectMesh, s.partId); }
    for (const p of this.parts.values()) p.material.emissive.set(s && s.face < 0 && p.info.id === s.partId ? 0x0b1f4d : this.highlighted.has(p.info.id) ? 0x5a3200 : 0x000000);
    this.onSelect(s);
    this.requestRender();
  }

  highlight(ids: string[]): void {
    this.highlighted = new Set(ids);
    this.select(this.selection);
  }

  private addMeasurePoint(p: THREE.Vector3): void {
    if (this.measurePts.length >= 2) this.clearMeasure();
    this.measurePts.push(p.clone());
    const r = this.radius() * 0.006;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 11;
    this.measureObj.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false }));
      line.renderOrder = 11;
      this.measureObj.add(line);
      this.onMeasure({ a, b, dist: a.distanceTo(b) });
    }
    this.requestRender();
  }

  // ------------------------------------------------------------------ rendering
  requestRender(): void { this.dirty = true; this.aoFresh = false; }

  private disposeComposer(): void {
    this.gtao?.dispose();
    this.composer?.renderTarget1.dispose();
    this.composer?.renderTarget2.dispose();
    this.composer = null;
    this.gtao = null;
    this.renderPass = null;
  }

  /** Composer with ground-truth AO; built lazily and rebuilt when the projection changes. */
  private ensureComposer(): EffectComposer {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    if (this.composer && this.renderPass?.camera === this.cam) return this.composer;
    this.disposeComposer();
    const dpr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * dpr, h * dpr, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    this.renderPass = new RenderPass(this.scene, this.cam);
    this.gtao = new CadGTAOPass(this.scene, this.cam, w * dpr, h * dpr);
    this.gtao.blendIntensity = 0.85;
    this.tuneAo();
    composer.addPass(this.renderPass);
    composer.addPass(this.gtao);
    composer.addPass(new OutputPass());
    this.composer = composer;
    return composer;
  }

  private tuneAo(): void {
    if (!this.gtao) return;
    const r = this.radius();
    this.gtao.updateGtaoMaterial({ radius: r * 0.06, distanceExponent: 1.5, thickness: r * 0.03, scale: 1.2, samples: 16 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  }

  private resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, true);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const halfH = 100;
    this.ortho.left = -halfH * (w / h); this.ortho.right = halfH * (w / h); this.ortho.top = halfH; this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
    this.disposeComposer();
    this.requestRender();
  }

  private updateClipping(): void {
    const r = this.radius();
    const d = this.persp.position.distanceTo(this.bounds.getCenter(new THREE.Vector3()));
    this.persp.near = Math.max(d - r * 3, d * 0.002, 0.01);
    this.persp.far = d + r * 6 + 10;
    this.persp.updateProjectionMatrix();
    this.ortho.near = -r * 20 - 1000;
    this.ortho.far = r * 40 + this.ortho.position.distanceTo(this.target) + 1000;
    this.ortho.updateProjectionMatrix();
    this.pivotDot.scale.setScalar(this.worldPerPixelAt(this.pivotDot.position) * 4);
  }

  private worldPerPixelAt(p: THREE.Vector3): number {
    const h = this.container.clientHeight || 1;
    if (this.cam === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.persp.position.distanceTo(p);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
  }

  private frames = 0;
  private fpsT = performance.now();

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.processHover();
    if (this.nav.update()) this.dirty = true;
    if (this.anim) { this.stepAnim(dt); this.dirty = true; }
    let flashing = false;
    for (const p of this.parts.values()) {
      if (p.flash > 0) {
        p.flash = Math.max(0, p.flash - dt);
        const k = Math.sin(Math.min(1, p.flash / 1.6) * Math.PI) * 0.55;
        p.material.emissive.copy(ACCENT).multiplyScalar(k);
        flashing = true;
        if (p.flash === 0) p.material.emissive.set(this.selection?.partId === p.info.id ? 0x0b1f4d : 0);
      }
    }
    if (flashing) this.dirty = true;
    if (!this.dirty) {
      // One ambient-occlusion frame once the view has been still for a moment.
      if (this.ambientOcclusion && !this.aoFresh && !this.nav.busy && now - this.idleTimer > 220) {
        this.aoFresh = true;
        this.renderNow(true);
      }
      return;
    }
    this.dirty = false;
    this.idleTimer = now;
    this.renderNow(false);
    this.frames++;
    if (now - this.fpsT > 1000) { this.onFrame((this.frames * 1000) / (now - this.fpsT)); this.frames = 0; this.fpsT = now; }
  };

  private renderNow(withAo = false): void {
    this.updateClipping();
    const r = this.renderer;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.autoClear = true;
    if (withAo) {
      try {
        this.ensureComposer().render();
      } catch (e) {
        console.warn("ambient occlusion disabled:", e);
        this.ambientOcclusion = false;
        r.render(this.scene, this.cam);
      }
    } else {
      r.render(this.scene, this.cam);
    }
    if (this.measurePts.length === 2) {
      const mid = this.measurePts[0].clone().add(this.measurePts[1]).multiplyScalar(0.5).project(this.cam);
      this.measureLabel.style.display = "block";
      this.measureLabel.style.left = `${((mid.x + 1) / 2) * w}px`;
      this.measureLabel.style.top = `${((1 - mid.y) / 2) * h}px`;
      const [a, b] = this.measurePts;
      this.measureLabel.textContent = `${a.distanceTo(b).toFixed(3)} mm  (Δx ${(b.x - a.x).toFixed(2)}  Δy ${(b.y - a.y).toFixed(2)}  Δz ${(b.z - a.z).toFixed(2)})`;
    }
    // ViewCube in the top-right corner.
    const s = this.cube.size;
    this.cube.sync(this.cam, this.target);
    const clip = r.clippingPlanes;
    r.clippingPlanes = [];
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(w - s - 8, h - s - 8, s, s);
    r.setViewport(w - s - 8, h - s - 8, s, s);
    r.clearDepth();
    const tm = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.render(this.cube.scene, this.cube.camera);
    r.toneMapping = tm;
    r.setScissorTest(false);
    r.autoClear = true;
    r.clippingPlanes = clip;
  }

  // ------------------------------------------------------------------ snapshots for agents
  async snapshot(req: SnapshotRequest): Promise<string> {
    const w = Math.round(req.width), h = Math.round(req.height);
    const ss = 2;
    // Render linear HDR, then the same tone mapping + sRGB output as the screen (three skips both for render targets).
    const rt = new THREE.WebGLRenderTarget(w * ss, h * ss, { type: THREE.HalfFloatType });
    const rtOut = new THREE.WebGLRenderTarget(w * ss, h * ss);
    const savedVis = new Map<string, [boolean, boolean]>();
    const only = req.parts?.length ? new Set(req.parts) : null;
    for (const p of this.parts.values()) {
      savedVis.set(p.info.id, [p.mesh.visible, p.edges.visible]);
      if (only && !only.has(p.info.id)) { p.mesh.visible = false; p.edges.visible = false; }
    }
    const savedEmissive = new Map<string, number>();
    if (req.highlight?.length) for (const p of this.parts.values()) { savedEmissive.set(p.info.id, p.material.emissive.getHex()); if (req.highlight.includes(p.info.id)) p.material.emissive.set(0x7a3d00); }
    const helpersVis = this.helpers.visible;
    this.helpers.visible = false;
    let cam: THREE.Camera = this.cam;
    if (req.view !== "current") {
      const [dir, up] = VIEW_DIRS[req.view];
      const st = this.fitState(dir, up, this.visibleBounds(req.parts?.length ? req.parts : undefined), w / h);
      const pc = this.persp.clone();
      pc.aspect = w / h;
      pc.up.copy(st.up);
      pc.position.copy(st.target).addScaledVector(st.dir, st.dist);
      pc.near = Math.max(st.dist * 0.01, 0.01);
      pc.far = st.dist * 10 + this.radius() * 4;
      pc.lookAt(st.target);
      pc.updateProjectionMatrix();
      cam = pc;
    } else if (this.cam === this.persp) {
      const pc = this.persp.clone();
      pc.aspect = w / h;
      pc.updateProjectionMatrix();
      cam = pc;
    }
    const r = this.renderer;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0xe9edf2, 1); // light background: best contrast for agents regardless of UI theme
    r.clear();
    r.render(this.scene, cam);
    const out = new OutputPass();
    out.renderToScreen = false;
    out.render(r, rtOut, rt, 0, false);
    const px = new Uint8Array(w * ss * h * ss * 4);
    r.readRenderTargetPixels(rtOut, 0, 0, w * ss, h * ss, px);
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    rtOut.dispose();
    out.dispose();
    for (const p of this.parts.values()) {
      const v = savedVis.get(p.info.id);
      if (v) { p.mesh.visible = v[0]; p.edges.visible = v[1]; }
      const em = savedEmissive.get(p.info.id);
      if (em !== undefined) p.material.emissive.setHex(em);
    }
    this.helpers.visible = helpersVis;
    this.requestRender();
    // Flip vertically into a canvas, then downsample 2x for anti-aliasing.
    const big = document.createElement("canvas");
    big.width = w * ss; big.height = h * ss;
    const bg = big.getContext("2d")!;
    const img = bg.createImageData(w * ss, h * ss);
    const row = w * ss * 4;
    for (let y = 0; y < h * ss; y++) img.data.set(px.subarray((h * ss - 1 - y) * row, (h * ss - y) * row), y * row);
    bg.putImageData(img, 0, 0);
    const small = document.createElement("canvas");
    small.width = w; small.height = h;
    const og = small.getContext("2d")!;
    og.imageSmoothingQuality = "high";
    og.drawImage(big, 0, 0, w, h);
    return small.toDataURL("image/png");
  }

  partBounds(id: string): PartInfo["bbox"] | null {
    const p = this.parts.get(id);
    if (!p) return null;
    const b = this.worldBox(p);
    return [b.min.toArray() as [number, number, number], b.max.toArray() as [number, number, number]];
  }

  // ------------------------------------------------------------------ placement (move / rotate / lay flat)
  /** World-space bounds of a part, including its placement. */
  private worldBox(p: PartObj): THREE.Box3 {
    const g = p.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox!.clone().applyMatrix4(p.mesh.matrix);
  }

  private applyPlacement(p: PartObj, m: THREE.Matrix4 | null): void {
    for (const o of [p.mesh, p.edges]) {
      if (m) o.matrix.copy(m); else o.matrix.identity();
      o.matrixWorldNeedsUpdate = true;
      o.updateMatrixWorld(true);
    }
  }

  /** Face overlays share the part's geometry, so they need its placement too. */
  private overlayFollow(o: THREE.Mesh, partId?: string): void {
    o.matrixAutoUpdate = false;
    const p = partId ? this.parts.get(partId) : null;
    if (p) o.matrix.copy(p.mesh.matrix); else o.matrix.identity();
    o.matrixWorldNeedsUpdate = true;
  }

  private placementChanged(): void {
    this.recomputeBounds();
    this.renderer.shadowMap.needsUpdate = true;
    if (this.selection) this.select(this.selection);
    this.requestRender();
  }

  /**
   * Stored placements from the project. `silent` (project just opened) applies them without
   * reporting deltas, because pins were saved in placed coordinates already.
   */
  setPlacements(all: Record<string, number[]> | undefined, silent = false): void {
    const next = new Map<string, THREE.Matrix4>();
    for (const [id, e] of Object.entries(all ?? {})) next.set(id, new THREE.Matrix4().fromArray(e));
    let changed = false;
    for (const id of new Set([...this.placements.keys(), ...next.keys()])) {
      const before = this.placements.get(id) ?? new THREE.Matrix4();
      const after = next.get(id) ?? new THREE.Matrix4();
      if (before.equals(after)) continue;
      changed = true;
      if (!silent) this.onPlacementDelta(id, after.clone().multiply(before.clone().invert()));
      const p = this.parts.get(id);
      if (p && !(this.tcDrag && this.tcState?.id === id)) this.applyPlacement(p, next.get(id) ?? null);
    }
    this.placements = next;
    if (changed) { if (this.tcState) this.startTransform(this.tcState.mode, this.tcState.id); this.placementChanged(); }
  }

  get transforming(): { mode: TransformMode; id: string } | null { return this.tcState; }

  /** Show a move (XY plane) or rotate (about Z) handle on a part. */
  startTransform(mode: TransformMode, id: string): boolean {
    const p = this.parts.get(id);
    if (!p) return false;
    if (!this.tc) {
      const tc = new TransformControls(this.cam, this.renderer.domElement);
      tc.setSpace("world");
      tc.setRotationSnap(THREE.MathUtils.degToRad(5));
      tc.addEventListener("change", () => this.requestRender());
      tc.addEventListener("dragging-changed", (e: any) => { this.nav.enabled = !e.value; });
      tc.addEventListener("mouseDown", () => {
        const cur = this.tcState && this.parts.get(this.tcState.id);
        if (!cur) return;
        this.tcProxy.updateMatrix();
        this.tcDrag = { p0: this.tcProxy.matrix.clone(), g0: cur.mesh.matrix.clone() };
      });
      tc.addEventListener("objectChange", () => {
        const cur = this.tcState && this.parts.get(this.tcState.id);
        if (!cur || !this.tcDrag) return;
        this.tcProxy.updateMatrix();
        const m = this.tcProxy.matrix.clone().multiply(this.tcDrag.p0.clone().invert()).multiply(this.tcDrag.g0);
        this.applyPlacement(cur, m);
        this.overlayFollow(this.selectMesh, cur.info.id);
        this.requestRender();
      });
      tc.addEventListener("mouseUp", () => {
        const cur = this.tcState && this.parts.get(this.tcState.id);
        const moved = cur && this.tcDrag && !cur.mesh.matrix.equals(this.tcDrag.g0);
        this.tcDrag = null;
        if (cur && moved) this.onPlacement(cur.info.id, Array.from(cur.mesh.matrix.elements));
      });
      const helper = tc.getHelper();
      helper.traverse((o) => { o.userData.noAO = true; });
      this.helpers.add(helper, this.tcProxy);
      this.tc = tc;
    }
    const tc = this.tc;
    (tc as any).camera = this.cam;
    tc.setMode(mode === "move" ? "translate" : "rotate");
    // Move in the build plane only; rotate about the vertical axis only.
    tc.showX = mode === "move"; tc.showY = mode === "move"; tc.showZ = mode === "rotate";
    this.tcProxy.position.copy(this.worldBox(p).getCenter(new THREE.Vector3()));
    this.tcProxy.quaternion.identity();
    this.tcProxy.updateMatrixWorld(true);
    tc.attach(this.tcProxy);
    this.tcState = { mode, id };
    this.onTransformChange(this.tcState);
    this.requestRender();
    return true;
  }

  stopTransform(): void {
    if (!this.tcState) return;
    this.tc?.detach();
    this.tcState = null;
    this.tcDrag = null;
    this.nav.enabled = true;
    this.onTransformChange(null);
    this.requestRender();
  }

  private currentMatrix(id: string): THREE.Matrix4 {
    return this.parts.get(id)?.mesh.matrix.clone() ?? new THREE.Matrix4();
  }

  /** Rotate the part so the face with world normal `n` faces down, then set it on the bed (z = 0). */
  layFlat(id: string, n: THREE.Vector3): void {
    const p = this.parts.get(id);
    if (!p) return;
    const q = new THREE.Quaternion().setFromUnitVectors(n.clone().normalize(), new THREE.Vector3(0, 0, -1));
    const c = this.worldBox(p).getCenter(new THREE.Vector3());
    const rot = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    const m = rot.multiply(this.currentMatrix(id));
    this.onPlacement(id, Array.from(this.dropped(p, m).elements));
  }

  /** Move the part straight down (or up) so it rests on the bed (z = 0). */
  dropToBed(id: string): void {
    const p = this.parts.get(id);
    if (p) this.onPlacement(id, Array.from(this.dropped(p, this.currentMatrix(id)).elements));
  }

  resetPlacement(id: string): void {
    if (this.parts.has(id)) this.onPlacement(id, null);
  }

  private dropped(p: PartObj, m: THREE.Matrix4): THREE.Matrix4 {
    const g = p.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    // Exact lowest point: transform the vertices, not just the box corners (rotations widen boxes).
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    let minZ = Infinity;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); if (v.z < minZ) minZ = v.z; }
    return new THREE.Matrix4().makeTranslation(0, 0, -minZ).multiply(m);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.clear();
    this.renderer.dispose();
  }
}
