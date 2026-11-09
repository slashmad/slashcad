// CAD mouse navigation (Fusion 360 / SolidWorks / Onshape mappings).
//
// Orbit is computed from the state at the start of each drag, never incrementally, so the same
// mouse movement always produces the same rotation and moving back returns exactly to the start
// (incremental yaw/pitch steps do not commute and make the model drift).
import * as THREE from "three";

export type MouseMapping = "fusion" | "solidworks" | "onshape";
export type NavTool = "select" | "orbit" | "pan" | "zoom";
export type OrbitStyle = "turntable" | "free";
export type OrbitAround = "origin" | "view-center" | "cursor";
type Action = "orbit" | "pan" | "zoom" | null;

export interface NavConfig {
  mapping: MouseMapping;
  rightDragOrbits: boolean;
  orbitStyle: OrbitStyle;
  orbitAround: OrbitAround;
  zoomToCursor: boolean;
  reverseZoom: boolean;
  zoomSpeed: number; // 1 = default
  smoothZoom: boolean;
  twoFingerPan: boolean;
}

export const DEFAULT_NAV: NavConfig = {
  mapping: "fusion",
  rightDragOrbits: true,
  orbitStyle: "turntable",
  orbitAround: "view-center",
  zoomToCursor: true,
  reverseZoom: false,
  zoomSpeed: 1,
  smoothZoom: true,
  twoFingerPan: true,
};

export interface NavHost {
  camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera;
  target: THREE.Vector3;
  dom: HTMLElement;
  pickPoint(clientX: number, clientY: number): THREE.Vector3 | null;
  changed(): void;
  setPivotMarker(p: THREE.Vector3 | null): void;
  sceneRadius(): number;
  onContextClick(clientX: number, clientY: number): void;
  onMiddleDoubleClick(): void;
}

interface Mods { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

/** Which navigation action a button + modifiers start. Exported for the settings table. */
export function actionFor(cfg: NavConfig, button: number, e: Mods, tool: NavTool = "select"): Action {
  const ctrl = e.ctrlKey || e.metaKey;
  if (button === 0 && tool !== "select" && !e.altKey) return tool;
  if (button === 0 && e.altKey) return e.shiftKey ? "pan" : "orbit"; // touchpad / no middle button
  switch (cfg.mapping) {
    case "fusion":
      if (button === 1) return e.shiftKey ? "orbit" : "pan";
      if (button === 2 && (cfg.rightDragOrbits || e.shiftKey)) return "orbit";
      return null;
    case "solidworks":
      if (button === 1) return ctrl ? "pan" : e.shiftKey ? "zoom" : "orbit";
      if (button === 2) return ctrl ? "pan" : cfg.rightDragOrbits ? "orbit" : null;
      return null;
    case "onshape":
      if (button === 2) return ctrl ? "pan" : "orbit";
      if (button === 1) return "pan";
      return null;
  }
}

/** Rows for the settings page: what each gesture does in a mapping. */
export function mappingTable(cfg: NavConfig): [string[], string][] {
  const rows: [string[], string][] = [];
  if (cfg.mapping === "fusion") rows.push([["Shift", "Middle drag"], "orbit"], [["Middle drag"], "pan"]);
  if (cfg.mapping === "solidworks") rows.push([["Middle drag"], "orbit"], [["Ctrl", "Middle drag"], "pan"], [["Shift", "Middle drag"], "zoom"]);
  if (cfg.mapping === "onshape") rows.push([["Right drag"], "orbit"], [["Ctrl", "Right drag"], "pan"], [["Middle drag"], "pan"]);
  if (cfg.mapping !== "onshape" && cfg.rightDragOrbits) rows.push([["Right drag"], "orbit"]);
  rows.push([["Wheel"], cfg.zoomToCursor ? "zoomCursor" : "zoomCenter"], [["Left click"], "select"], [["Right click"], "contextMenu"], [["Alt", "Left drag"], "orbit"]);
  return rows;
}

interface OrbitStart {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  camUp: THREE.Vector3;
  pivot: THREE.Vector3;
  x: number;
  y: number;
}

const K_ORBIT = 0.0065; // radians per pixel

export class Navigation {
  cfg: NavConfig = { ...DEFAULT_NAV };
  tool: NavTool = "select";
  enabled = true;
  private action: Action = null;
  private button = -1;
  private last = new THREE.Vector2();
  private downAt = new THREE.Vector2();
  private orbitStart: OrbitStart | null = null;
  private panPoint = new THREE.Vector3();
  private pointerId = -1;
  private moved = false;
  private lastMiddleDown = 0;
  private zoomPending = 0; // log factor still to apply (smooth zoom)
  private zoomAt = { x: 0, y: 0 };

  constructor(private host: NavHost) {
    const d = host.dom;
    d.addEventListener("pointerdown", this.onDown);
    d.addEventListener("pointermove", this.onMove);
    d.addEventListener("pointerup", this.onUp);
    d.addEventListener("pointercancel", this.onUp);
    d.addEventListener("wheel", this.onWheel, { passive: false });
    d.addEventListener("contextmenu", (e) => e.preventDefault());
    d.addEventListener("auxclick", (e) => e.preventDefault());
  }

  get busy(): boolean { return this.action !== null; }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.button === 1) {
      const now = performance.now();
      if (now - this.lastMiddleDown < 350) { this.lastMiddleDown = 0; this.host.onMiddleDoubleClick(); e.preventDefault(); return; }
      this.lastMiddleDown = now;
    }
    const a = actionFor(this.cfg, e.button, e, this.tool);
    if (!a && e.button !== 2) return;
    e.preventDefault();
    this.action = a;
    this.button = e.button;
    this.moved = false;
    this.pointerId = e.pointerId;
    this.host.dom.setPointerCapture(e.pointerId);
    this.last.set(e.clientX, e.clientY);
    this.downAt.set(e.clientX, e.clientY);
    if (a === "orbit") this.beginOrbit(e.clientX, e.clientY);
    else if (a === "pan") this.panPoint.copy(this.host.pickPoint(e.clientX, e.clientY) ?? this.host.target);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 3) this.moved = true;
    if (!this.action || !this.moved) { this.last.set(e.clientX, e.clientY); return; }
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    if (this.action === "orbit") this.orbitTo(e.clientX, e.clientY);
    else if (this.action === "pan") this.pan(dx, dy);
    else if (this.action === "zoom") {
      const r = this.host.dom.getBoundingClientRect();
      this.zoomBy(r.left + r.width / 2, r.top + r.height / 2, Math.exp(dy * 0.006));
    }
    this.host.changed();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (this.button === 2 && !this.moved) this.host.onContextClick(e.clientX, e.clientY);
    this.action = null;
    this.button = -1;
    this.pointerId = -1;
    this.orbitStart = null;
    this.host.setPivotMarker(null);
    try { this.host.dom.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // Touchpads send pixel deltas with horizontal components or fractions; pinch arrives as ctrl+wheel.
    const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY));
    if (this.cfg.twoFingerPan && trackpad && !e.ctrlKey) {
      this.panPoint.copy(this.host.target);
      this.pan(-e.deltaX, -e.deltaY);
      this.host.changed();
      return;
    }
    let dir = this.cfg.reverseZoom ? -1 : 1;
    if (this.cfg.mapping === "solidworks") dir = -dir;
    const logF = dir * e.deltaY * px * 0.0012 * this.cfg.zoomSpeed * (e.ctrlKey && trackpad ? 2.5 : 1);
    const r = this.host.dom.getBoundingClientRect();
    this.zoomAt = this.cfg.zoomToCursor ? { x: e.clientX, y: e.clientY } : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (this.cfg.smoothZoom) this.zoomPending += logF;
    else { this.zoomBy(this.zoomAt.x, this.zoomAt.y, Math.exp(logF)); this.host.changed(); }
  };

  /** Called every frame by the viewer; returns true while smooth zoom is still moving. */
  update(): boolean {
    if (Math.abs(this.zoomPending) < 1e-4) { this.zoomPending = 0; return false; }
    const step = this.zoomPending * 0.35;
    this.zoomPending -= step;
    this.zoomBy(this.zoomAt.x, this.zoomAt.y, Math.exp(step));
    return true;
  }

  // ------------------------------------------------------------------ orbit
  private beginOrbit(clientX: number, clientY: number): void {
    const cam = this.host.camera();
    cam.updateMatrixWorld();
    let pivot: THREE.Vector3;
    if (this.cfg.orbitAround === "origin") pivot = new THREE.Vector3();
    else if (this.cfg.orbitAround === "cursor") pivot = this.host.pickPoint(clientX, clientY) ?? this.host.target.clone();
    else pivot = this.host.target.clone();
    this.orbitStart = {
      pos: cam.position.clone(),
      target: this.host.target.clone(),
      up: cam.up.clone(),
      right: new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize(),
      camUp: new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize(),
      pivot,
      x: clientX,
      y: clientY,
    };
    this.host.setPivotMarker(pivot);
  }

  private rotationFor(s: OrbitStart, dx: number, dy: number): THREE.Quaternion {
    if (this.cfg.orbitStyle === "free") {
      // Trackball: rotate about the screen axis perpendicular to the drag.
      const axis = s.camUp.clone().multiplyScalar(dx).add(s.right.clone().multiplyScalar(dy));
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return new THREE.Quaternion();
      return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), -len * K_ORBIT);
    }
    // Turntable: yaw about world Z, pitch about the start right axis; never past the poles.
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * K_ORBIT);
    const fwd0 = s.target.clone().sub(s.pos).normalize();
    const elev0 = Math.asin(THREE.MathUtils.clamp(fwd0.z, -1, 1)); // < 0 when looking down
    const limit = THREE.MathUtils.degToRad(89.5);
    // Pitching about `right` (= forward × up) by angle a raises the look elevation by a.
    const a = THREE.MathUtils.clamp(-dy * K_ORBIT, -limit - elev0, limit - elev0);
    const pitch = new THREE.Quaternion().setFromAxisAngle(s.right, a);
    return yaw.multiply(pitch);
  }

  private orbitTo(clientX: number, clientY: number): void {
    const s = this.orbitStart;
    if (!s) return;
    const q = this.rotationFor(s, clientX - s.x, clientY - s.y);
    const cam = this.host.camera();
    cam.position.copy(s.pos).sub(s.pivot).applyQuaternion(q).add(s.pivot);
    this.host.target.copy(s.target).sub(s.pivot).applyQuaternion(q).add(s.pivot);
    cam.up.copy(this.cfg.orbitStyle === "turntable" ? new THREE.Vector3(0, 0, 1) : s.up.clone().applyQuaternion(q));
    cam.lookAt(this.host.target);
    cam.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ pan / zoom
  private worldPerPixel(atPoint: THREE.Vector3): number {
    const cam = this.host.camera();
    const h = this.host.dom.clientHeight || 1;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera;
      return (o.top - o.bottom) / o.zoom / h;
    }
    const p = cam as THREE.PerspectiveCamera;
    const viewDir = new THREE.Vector3();
    cam.getWorldDirection(viewDir);
    const depth = Math.max(new THREE.Vector3().subVectors(atPoint, cam.position).dot(viewDir), 1e-3);
    return (2 * depth * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / h;
  }

  pan(dx: number, dy: number): void {
    const cam = this.host.camera();
    cam.updateMatrixWorld();
    const s = this.worldPerPixel(this.panPoint);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const move = right.multiplyScalar(-dx * s).add(up.multiplyScalar(dy * s));
    cam.position.add(move);
    this.host.target.add(move);
    cam.updateMatrixWorld();
  }

  zoomBy(clientX: number, clientY: number, factor: number): void {
    const cam = this.host.camera();
    const t = this.host.target;
    const r = this.host.sceneRadius();
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera;
      const before = this.unproject(clientX, clientY);
      o.zoom = THREE.MathUtils.clamp(o.zoom / factor, 1e-4, 1e6);
      o.updateProjectionMatrix();
      const d = before.sub(this.unproject(clientX, clientY));
      cam.position.add(d);
      t.add(d);
    } else {
      const point = this.host.pickPoint(clientX, clientY) ?? this.planePoint(clientX, clientY);
      const dist = cam.position.distanceTo(point);
      let f = factor;
      if (dist * f < r * 1e-4) f = (r * 1e-4) / dist;
      if (dist * f > r * 200) f = (r * 200) / dist;
      cam.position.sub(point).multiplyScalar(f).add(point);
      t.sub(point).multiplyScalar(f).add(point);
    }
    cam.updateMatrixWorld();
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.host.dom.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private unproject(clientX: number, clientY: number): THREE.Vector3 {
    const n = this.ndc(clientX, clientY);
    return new THREE.Vector3(n.x, n.y, 0).unproject(this.host.camera());
  }

  /** Point on the plane through the view centre facing the camera (nothing under the cursor). */
  private planePoint(clientX: number, clientY: number): THREE.Vector3 {
    const cam = this.host.camera();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.ndc(clientX, clientY), cam);
    const n = new THREE.Vector3();
    cam.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.host.target);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.host.target.clone();
  }
}
