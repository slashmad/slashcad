// Coalescing build queue + build history. Only one build runs; edits during a build queue one more.
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildResult, BuildState, PosePreview } from "../shared/types";
import type { CadWorker } from "./cadWorker";
import { readDesign } from "./design";
import type { Project } from "./project";
import { getSettings } from "./settings";

export class Builder extends EventEmitter {
  private running: Promise<BuildResult> | null = null;
  private queuedTrigger: string | null = null;
  private waiters: ((r: BuildResult) => void)[] = [];
  history: BuildResult[] = [];
  last: BuildResult | null = null;
  state: BuildState = { running: false, workerReady: false };
  private n = 0;
  /** A parameter value shown in the view without touching the file (motion study preview). */
  preview: PosePreview | null = null;

  constructor(private worker: CadWorker, private project: () => Project | null) {
    super();
    worker.on("progress", (m) => this.setState({ message: m.message }));
    worker.on("status", () => this.setState({ workerReady: worker.ready, workerError: worker.lastError || undefined }));
  }

  private setState(patch: Partial<BuildState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  /** Request a build; resolves with the build that includes this request. */
  request(trigger: string): Promise<BuildResult> {
    if (this.running) {
      this.queuedTrigger = trigger;
      this.setState({ queued: true });
      return new Promise((resolve) => this.waiters.push(resolve));
    }
    return this.run(trigger);
  }

  private async run(trigger: string): Promise<BuildResult> {
    const project = this.project();
    if (!project) throw new Error("no project is open");
    const startedAt = Date.now();
    this.setState({ running: true, message: "Building…", queued: false });
    this.emit("start", { trigger });
    const p = (async () => {
      try {
        const res = await this.worker.request("build", {
          project_dir: project.dir,
          cache_dir: project.cacheDir,
          sources: project.buildableScene(),
          quality: project.info.quality,
          placements: project.info.placements ?? {},
          materials: readDesign(project).materials ?? {},
          overrides: this.preview ? { [this.preview.file]: { [this.preview.param]: this.preview.value } } : {},
        }, getSettings().buildTimeoutSec * 1000);
        const result: BuildResult = { n: ++this.n, trigger, startedAt, ...res, preview: this.preview };
        return result;
      } catch (e: any) {
        const result: BuildResult = {
          n: ++this.n, trigger, startedAt, parts: this.last?.parts.map((pt) => ({ ...pt, changed: false, stale: true })) ?? [],
          sources: [{ source: "(arbetsprocess)", log: e.traceback ?? "", error: { message: e.message, line: null, traceback: e.traceback ?? "" }, seconds: 0, parts: 0 }],
          removed: [], seconds: (Date.now() - startedAt) / 1000, quality: project.info.quality,
        };
        return result;
      }
    })();
    this.running = p;
    const result = await p;
    this.running = null;
    this.last = result;
    this.history.push(result);
    if (this.history.length > 100) this.history.shift();
    try {
      const slim = { ...result, parts: result.parts.map(({ id, key, changed, source }) => ({ id, key, changed, source })) };
      appendFileSync(join(project.stateDir, "history.jsonl"), JSON.stringify(slim) + "\n");
    } catch { /* non-fatal */ }
    this.setState({ running: false, message: undefined });
    this.emit("result", result);
    if (this.queuedTrigger) {
      const t = this.queuedTrigger;
      this.queuedTrigger = null;
      const waiters = this.waiters.splice(0);
      this.run(t).then((r) => waiters.forEach((w) => w(r)));
    }
    return result;
  }

  reset(): void {
    this.preview = null;
    this.history = [];
    this.last = null;
    this.n = 0;
  }
}
