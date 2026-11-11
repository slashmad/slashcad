// Types shared by main process, preload and renderer.

export type AgentKind = "claude" | "codex";

export interface FileNode {
  name: string;
  path: string; // relative to project root, "/" separated
  dir: boolean;
  children?: FileNode[];
  size?: number;
}

export interface ProjectInfo {
  dir: string;
  name: string;
  scene: string[]; // relative paths of sources shown in the viewer
  quality: "draft" | "normal" | "fine";
  trusted: boolean; // scripts in this folder may run
  isNew?: boolean;
  singleFile?: string; // set when a single model file was opened
  scripts?: string[]; // .py entries of the scene
  /** User placement per part id: a column-major 4x4 matrix (THREE.Matrix4.elements), rigid only. */
  placements?: Record<string, number[]>;
}

/** Undo/redo availability, with the labels of the next steps. */
export interface HistoryState {
  undo: string | null;
  redo: string | null;
}

export interface PartInfo {
  id: string;
  name: string;
  source: string;
  key: string;
  color: [number, number, number, number] | null;
  mesh: string;
  bbox: [[number, number, number], [number, number, number]];
  changed: boolean;
  stale?: boolean;
  geom?: string; // geometry fingerprint (mesh-quality independent)
  material?: string | null;
}

export interface SourceStatus {
  source: string;
  log: string;
  error: { message: string; line: number | null; traceback: string } | null;
  seconds: number;
  parts: number;
}

export interface BuildResult {
  n: number;
  trigger: string;
  startedAt: number;
  parts: PartInfo[];
  sources: SourceStatus[];
  removed: string[];
  seconds: number;
  quality: string;
  preview?: PosePreview | null; // set when the build shows a pose preview instead of the file's value
}

export interface BuildState {
  running: boolean;
  message?: string;
  queued?: boolean;
  workerReady: boolean;
  workerError?: string;
}

/** Normalised agent events (Claude stream-json and Codex app-server map onto these). */
export type AgentEvent =
  | { type: "status"; state: "starting" | "idle" | "busy" | "stopped" | "error"; detail?: string }
  | { type: "session"; sessionId: string; model?: string; title?: string }
  | { type: "user"; id: string; text: string; ts: number }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text"; id: string; text: string; ts: number }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; output?: string; ts: number }
  | { type: "permission"; requestId: string; tool: string; input: unknown; description?: string; canAlways: boolean }
  | { type: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { type: "turn-complete"; durationMs?: number; usage?: TurnUsage; error?: string }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "error"; message: string }
  | { type: "history-reset" };

export type PermissionDecision = "allow" | "allow-always" | "deny";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costEstimateUsd?: number;
}

export interface UsageWindow {
  label: string; // "5 h", "7 dagar"
  usedPercent: number; // 0..100
  resetsAt?: number; // unix seconds
  status?: string;
}

export interface UsageSnapshot {
  agent: AgentKind;
  plan?: string;
  windows: UsageWindow[];
  contextUsed?: number;
  contextWindow?: number;
  sessionTokens?: { input: number; output: number; cached: number };
  note?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  agent: AgentKind;
}

export interface Annotation {
  id: string;
  n: number;
  partId: string;
  partName: string;
  source: string;
  face: number; // -1 = whole part
  point: [number, number, number];
  normal: [number, number, number] | null;
  faceInfo: Record<string, unknown> | null;
  text: string;
  status: "open" | "done";
  agentNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Param {
  file: string;
  name: string;
  value: number;
  line: number;
  comment: string;
  integer: boolean;
}

export interface Settings {
  settingsVersion?: number;
  language: "en" | "sv";
  navigation: "fusion" | "solidworks" | "onshape"; // mouse mapping
  rightDragOrbits: boolean;
  orbitStyle: "turntable" | "free";
  orbitAround: "origin" | "view-center" | "cursor";
  middleDoubleClick: "home" | "fit" | "none";
  zoomToCursor: boolean;
  reverseZoom: boolean;
  zoomSpeed: number;
  smoothZoom: boolean;
  twoFingerPan: boolean;
  animateViews: boolean;
  animationSpeed: number;
  fitSize: number; // 0.5..1 share of the viewport used by Home/Fit
  fitOnViewChange: boolean;
  theme: "dark" | "light";
  ambientOcclusion: boolean;
  projection: "perspective" | "orthographic";
  displayBackend: "auto" | "wayland" | "x11";
  solidcraftEnabled: boolean;
  solidcraftCliPath?: string;
  solidcraftAppPath?: string;
  claudePath?: string;
  codexPath?: string;
  pythonPath?: string;
  claudeModel?: string;
  codexModel?: string;
  recentProjects: string[];
  lastAgent: AgentKind;
  buildTimeoutSec: number;
  /** Printing: the user's printer for printability checks and print packages. */
  printerBed: [number, number, number];
  printerNozzle: number;
  printerLayer: number;
  overhangDeg: number;
  fitClearance: number; // sliding fit the user's printer achieves (mm)
  slicerPath?: string; // PrusaSlicer / SuperSlicer CLI; auto-detected when empty
}

// ---------------------------------------------------------------- design checks

export type RuleKind = "interference" | "allow_contact" | "clearance" | "envelope" | "protected" | "retained" | "path_clear";

/** One rule in slashcad.rules.json. Part patterns are globs on the part name or id. */
export interface DesignRule {
  id: string;
  kind: RuleKind;
  note?: string;
  a?: string | string[];
  b?: string | string[];
  min?: number;
  parts?: string | string[];
  max?: [number | null, number | null, number | null];
  fingerprints?: Record<string, string>;
  part?: string | string[];
  against?: string | string[];
  direction?: [number, number, number];
  directions?: [number, number, number][];
  within?: number;
  distance?: number;
  step?: number;
  enabled?: boolean;
  by?: string; // who added it: "user" or the agent's name
}

export interface DesignFile {
  version: 1;
  rules: DesignRule[];
  materials?: Record<string, { density?: number; color?: string; label?: string }>;
  /** Default motion study: the parameter and range used by "Run sweep". */
  sweep?: { param: string; from: number; to: number; step: number; file?: string };
}

export interface RuleResult {
  id: string;
  kind: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  parts?: string[];
  pairs?: PairResult[];
  value?: unknown;
}

export interface PairResult {
  a: string;
  b: string;
  a_name: string;
  b_name: string;
  kind: "interference" | "touch" | "near";
  distance_mm: number;
  overlap_mm3: number | null;
  allowed_by: string | null;
}

export interface DesignReport {
  build: number;
  at: number;
  results: RuleResult[];
  pairs: PairResult[];
  pair_count: number;
  summary: { fail: number; warn: number; pass: number };
  parts: number;
  seconds: number;
  error?: string;
  skipped?: string; // why automatic checks did not run
}

export interface SweepPose {
  value: number;
  interferences: number;
  worst: PairResult | null;
  rule_failures: { id: string; kind: string; detail: string }[];
  errors: string[];
}

export interface SweepResult {
  param: string;
  scripts: string[];
  values: number[];
  poses_checked: number;
  poses: SweepPose[];
  closest_pairs: (Omit<PairResult, "distance_mm" | "overlap_mm3"> & { min_distance_mm: number; max_overlap_mm3: number | null; at: number })[];
  failing_poses: number[];
  near_mm: number;
  seconds: number;
  complete: boolean;
  at?: number;
}

export interface PrintReport {
  id: string;
  name: string;
  size_mm?: [number, number, number];
  fits_bed?: boolean;
  overhang_mm2?: number;
  flat_down_mm2?: number;
  bed_contact_mm2?: number;
  surface_mm2?: number;
  overhang_z_range?: [number, number] | null;
  orientations?: { orientation: string; overhang_mm2: number; bed_contact_mm2: number; height_mm: number }[];
  best_orientation?: string;
  hints?: string[];
  error?: string;
  slice?: SliceResult[];
}

export interface SliceResult {
  support: boolean;
  slicer: string;
  seconds: number;
  warnings: string[];
  support_filament_mm: number;
  total_filament_mm: number;
  layers: number;
  footer: Record<string, string>;
}

/** Pose preview: a parameter value shown in the view without changing the file. */
export interface PosePreview {
  file: string;
  param: string;
  value: number;
}

/** A physical test or measurement in slashcad.tests.json (primary evidence over nominal CAD). */
export interface TestEntry {
  id: string;
  date: string; // ISO date
  title: string;
  result: "pass" | "fail" | "partial" | "note";
  observations: string;
  parts?: string[]; // part names
  measurements?: { what: string; value: number; unit: string; nominal?: number }[];
  photos?: string[]; // project-relative paths (references/…)
  revision?: string;
  by?: string;
  createdAt: number;
}

export interface McpActivity {
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
  ts: number;
}

export interface FileDiff {
  path: string;
  hunks: { type: "same" | "add" | "del"; lines: string[]; oldStart: number; newStart: number }[];
  ts: number;
}

export type ViewName = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom" | "current";

export interface SnapshotRequest {
  reqId: string;
  view: ViewName;
  width: number;
  height: number;
  highlight?: string[];
  parts?: string[];
}
