// Supervises the resident Python CAD worker: start, request/response, crash restart, timeouts.
import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSettings } from "./settings";
import { solidcraftInfo } from "./solidcraft";

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; cmd: string }

const isWin = process.platform === "win32";

export function resolvePython(): { python: string; pythonPath: string } {
  const s = getSettings();
  const appRoot = app.getAppPath();
  const devRoot = join(appRoot); // package root in dev
  const packagedPy = join(process.resourcesPath ?? "", "python", isWin ? "python.exe" : join("bin", "python3"));
  const devVenv = join(devRoot, ".venv", isWin ? join("Scripts", "python.exe") : join("bin", "python"));
  const candidates = [s.pythonPath, process.env.SLASHCAD_PYTHON, app.isPackaged ? packagedPy : devVenv, packagedPy, devVenv]
    .filter((p): p is string => !!p);
  const python = candidates.find((p) => existsSync(p)) ?? (isWin ? "python" : "python3");
  const pythonPath = app.isPackaged ? join(process.resourcesPath, "python-src") : join(devRoot, "python");
  return { python, pythonPath };
}

export class CadWorker extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  ready = false;
  lastError = "";
  private stopping = false;
  private restarts = 0;

  start(): void {
    const { python, pythonPath } = resolvePython();
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: pythonPath, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
    const sc = solidcraftInfo().cli;
    if (sc) env.SLASHCAD_SOLIDCRAFT_CLI = sc; // lets the worker turn .sc designs into STEP
    delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE;
    this.ready = false;
    this.emit("status");
    const proc = spawn(python, ["-X", "utf8", "-m", "slashcad_worker"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => this.emit("stderr", d));
    proc.on("error", (e) => {
      this.lastError = `Could not start Python (${python}): ${e.message}`;
      this.emit("status");
    });
    proc.on("exit", (code, sig) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`the CAD worker exited (${code ?? sig}) during ${p.cmd}`)); }
      this.pending.clear();
      this.emit("status");
      if (!this.stopping) {
        this.restarts++;
        const delay = Math.min(5000, 300 * this.restarts);
        this.lastError = this.lastError || `the CAD worker exited (${code ?? sig}); restarting`;
        setTimeout(() => !this.stopping && this.start(), delay);
      }
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { this.emit("stderr", "protocol: " + line); continue; }
      if (msg.event === "ready") {
        this.ready = true;
        this.restarts = 0;
        this.lastError = "";
        this.emit("ready", msg);
        this.emit("status");
      } else if (msg.event === "progress") {
        this.emit("progress", msg);
      } else if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error), { traceback: msg.traceback }));
      }
    }
  }

  async waitReady(timeoutMs = 60000): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { this.off("ready", ok); reject(new Error(this.lastError || "the CAD worker did not start in time")); }, timeoutMs);
      const ok = () => { clearTimeout(t); resolve(); };
      this.once("ready", ok);
    });
  }

  async request<T = any>(cmd: string, params: unknown, timeoutMs = 120000): Promise<T> {
    await this.waitReady();
    const proc = this.proc;
    if (!proc) throw new Error("the CAD worker is not running");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} took longer than ${Math.round(timeoutMs / 1000)} s; restarting the CAD worker`));
        this.restart();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cmd });
      proc.stdin.write(JSON.stringify({ id, cmd, params }) + "\n");
    });
  }

  restart(): void {
    const p = this.proc;
    if (p) { p.kill(); setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 2000); }
    else if (!this.stopping) this.start();
  }

  stop(): void {
    this.stopping = true;
    this.proc?.kill();
  }
}
