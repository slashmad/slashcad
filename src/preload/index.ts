import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const on = (channel: string) => (cb: (...args: any[]) => void) => {
  const h = (_e: IpcRendererEvent, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const api = {
  info: () => ipcRenderer.invoke("app:info"),
  setSettings: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  project: {
    openDialog: () => ipcRenderer.invoke("project:openDialog"),
    openFileDialog: () => ipcRenderer.invoke("project:openFileDialog"),
    trust: () => ipcRenderer.invoke("project:trust"),
    makeProject: () => ipcRenderer.invoke("project:makeProject"),
    /** Absolute path of a dropped File (Electron removed File.path). */
    pathForFile: (f: File) => webUtils.getPathForFile(f),
    newDialog: () => ipcRenderer.invoke("project:newDialog"),
    open: (dir: string) => ipcRenderer.invoke("project:open", dir),
    readText: (rel: string) => ipcRenderer.invoke("project:readText", rel),
    diffs: () => ipcRenderer.invoke("project:diffs"),
    setScene: (scene: string[]) => ipcRenderer.invoke("project:setScene", scene),
    setQuality: (q: string) => ipcRenderer.invoke("project:setQuality", q),
    reveal: (rel: string) => ipcRenderer.invoke("project:reveal", rel),
    installMcp: () => ipcRenderer.invoke("project:installMcp"),
    importPaths: (paths: string[], destDir?: string): Promise<string[]> => ipcRenderer.invoke("project:import", paths, destDir),
    importDialog: (destDir?: string): Promise<string[]> => ipcRenderer.invoke("project:importDialog", destDir),
    remove: (rels: string[]): Promise<number> => ipcRenderer.invoke("project:delete", rels),
    onOpened: on("project:opened"),
    onChanged: on("project:changed"),
    onInfo: on("project:info"),
  },
  history: {
    undo: (): Promise<string | null> => ipcRenderer.invoke("history:undo"),
    redo: (): Promise<string | null> => ipcRenderer.invoke("history:redo"),
    state: () => ipcRenderer.invoke("history:state"),
    onState: on("history:state"),
  },
  placement: {
    set: (id: string, matrix: number[] | null) => ipcRenderer.invoke("placement:set", id, matrix),
  },
  cad: {
    build: () => ipcRenderer.invoke("cad:build"),
    restartWorker: () => ipcRenderer.invoke("cad:restartWorker"),
    mesh: (path: string): Promise<Uint8Array> => ipcRenderer.invoke("cad:mesh", path),
    inspect: (ids?: string[]) => ipcRenderer.invoke("cad:inspect", ids),
    faceInfo: (id: string, face: number) => ipcRenderer.invoke("cad:faceInfo", id, face),
    export: (format: string, ids?: string[]) => ipcRenderer.invoke("cad:export", format, ids),
    onState: on("cad:state"),
    onResult: on("cad:result"),
    onStderr: on("cad:stderr"),
  },
  agent: {
    start: (kind: string, resumeId?: string) => ipcRenderer.invoke("agent:start", kind, resumeId),
    send: (text: string) => ipcRenderer.invoke("agent:send", text),
    interrupt: () => ipcRenderer.invoke("agent:interrupt"),
    stop: () => ipcRenderer.invoke("agent:stop"),
    permission: (id: string, decision: string) => ipcRenderer.invoke("agent:permission", id, decision),
    sessions: (kind: string) => ipcRenderer.invoke("agent:sessions", kind),
    auth: (kind: string) => ipcRenderer.invoke("agent:auth", kind),
    login: (kind: string) => ipcRenderer.invoke("agent:login", kind),
    loginInput: (text: string) => ipcRenderer.invoke("agent:loginInput", text),
    onLoginOutput: on("agent:login-output"),
    onAuthChanged: on("agent:auth-changed"),
    onEvent: on("agent:event"),
    onMcpActivity: on("mcp:activity"),
  },
  annotations: {
    list: () => ipcRenderer.invoke("annotations:list"),
    add: (a: unknown) => ipcRenderer.invoke("annotations:add", a),
    update: (id: string, patch: unknown) => ipcRenderer.invoke("annotations:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("annotations:remove", id),
    clearDone: () => ipcRenderer.invoke("annotations:clearDone"),
    onChanged: on("annotations:changed"),
  },
  params: {
    list: () => ipcRenderer.invoke("params:list"),
    set: (file: string, line: number, name: string, value: number) => ipcRenderer.invoke("params:set", file, line, name, value),
    onChanged: on("params:changed"),
  },
  checks: {
    report: () => ipcRenderer.invoke("checks:report"),
    sweep: () => ipcRenderer.invoke("checks:sweep"),
    prints: () => ipcRenderer.invoke("checks:prints"),
    run: (ids?: string[]) => ipcRenderer.invoke("checks:run", ids),
    runSweep: (opts: unknown) => ipcRenderer.invoke("checks:sweep:run", opts),
    printability: (ids?: string[]) => ipcRenderer.invoke("checks:printability", ids),
    slice: (id: string, support: boolean) => ipcRenderer.invoke("checks:slice", id, support),
    slicer: (): Promise<string | null> => ipcRenderer.invoke("checks:slicer"),
    preview: (p: unknown) => ipcRenderer.invoke("checks:preview", p),
    onReport: on("checks:report"),
    onSweep: on("checks:sweep"),
    onPrints: on("checks:prints"),
    onRunning: on("checks:running"),
  },
  design: {
    get: () => ipcRenderer.invoke("design:get"),
    addRule: (rule: unknown) => ipcRenderer.invoke("design:addRule", rule),
    removeRule: (id: string) => ipcRenderer.invoke("design:removeRule", id),
    setSweep: (sweep: unknown) => ipcRenderer.invoke("design:setSweep", sweep),
    protect: (ids: string[], note?: string) => ipcRenderer.invoke("design:protect", ids, note),
    onChanged: on("design:changed"),
  },
  tests: {
    list: () => ipcRenderer.invoke("tests:list"),
    add: (t: unknown) => ipcRenderer.invoke("tests:add", t),
    update: (id: string, patch: unknown) => ipcRenderer.invoke("tests:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("tests:remove", id),
    onChanged: on("tests:changed"),
  },
  solidcraft: {
    info: () => ipcRenderer.invoke("solidcraft:info"),
    open: (rel?: string) => ipcRenderer.invoke("solidcraft:open", rel),
  },
  viewer: {
    onSnapshot: on("viewer:snapshot"),
    snapshotDone: (reqId: string, dataUrl: string | null, error?: string) => ipcRenderer.send("viewer:snapshot-done", reqId, dataUrl, error),
    onHighlight: on("viewer:highlight"),
  },
};

contextBridge.exposeInMainWorld("slashcad", api);
export type SlashCadApi = typeof api;
