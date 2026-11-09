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
