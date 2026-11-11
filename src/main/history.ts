// Undo/redo for the open project (Ctrl+Z / Ctrl+Shift+Z).
//
// What is undoable:
//  - text edits seen by the file watcher (agent edits, parameter changes, an external editor),
//    coalesced per file while the same file keeps changing;
//  - files the app deletes or imports (deleted files move to .slashcad/trash, so undo restores
//    them; imported files move there on undo, so redo puts them back);
//  - scene changes and part placements.
// The history lives in memory per project. Trash entries older than TRASH_DAYS are purged when a
// project opens.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryState } from "../shared/types";
import type { Project } from "./project";

export type Op =
  | { kind: "text"; path: string; before: string | null; after: string | null }
  | { kind: "file"; path: string; stash: string; present: boolean } // present: the file exists after the op
  | { kind: "scene"; before: string[]; after: string[] }
  | { kind: "placement"; id: string; before: number[] | null; after: number[] | null };

interface Entry { label: string; ops: Op[]; ts: number; coalesce?: string }

const LIMIT = 200;
const COALESCE_MS = 2500;
const TRASH_DAYS = 14;

export class History extends EventEmitter {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private applying = false;
  private collecting: Op[] | null = null;

  constructor(private project: Project) {
    super();
    purgeTrash(this.trashDir);
    project.on("changed", ({ edits }) => { if (!this.applying) this.recordEdits(edits ?? []); });
    project.on("scene-changed", ({ before, after }) => { if (!this.applying) this.push("change the shown files", [{ kind: "scene", before, after }]); });
    project.on("placement-changed", ({ id, before, after }) => {
      if (!this.applying) this.push(after ? "move/rotate a part" : "reset a placement", [{ kind: "placement", id, before, after }]);
    });
  }

  /** Run fn and record everything it changes (files, scene, placements) as one undo step. */
  group<T>(label: string, fn: (ops: Op[]) => T): T {
    const outer = this.collecting;
    const ops: Op[] = [];
    this.collecting = ops;
    try {
      return fn(ops);
    } finally {
      this.collecting = outer;
      this.push(label, ops);
    }
  }

  get trashDir(): string { return join(this.project.stateDir, "trash"); }

  /** A fresh, unique stash path for a project file. */
  stashPath(rel: string): string {
    const dir = join(this.trashDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return join(dir, rel.split("/").pop() || "file");
  }

  state(): HistoryState {
    return { undo: this.undoStack.at(-1)?.label ?? null, redo: this.redoStack.at(-1)?.label ?? null };
  }

  push(label: string, ops: Op[], coalesce?: string): void {
    if (!ops.length) return;
    if (this.collecting && this.collecting !== ops) { this.collecting.push(...ops); return; }
    const top = this.undoStack.at(-1);
    if (coalesce && top?.coalesce === coalesce && Date.now() - top.ts < COALESCE_MS) {
      merge(top, ops);
      top.ts = Date.now();
    } else {
      this.undoStack.push({ label, ops, ts: Date.now(), coalesce });
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit("state", this.state());
  }

  /** Text edits from the file watcher. */
  recordEdits(edits: { path: string; before: string | null; after: string }[]): void {
    if (!edits.length) return;
    const ops: Op[] = edits.map((e) => ({ kind: "text", path: e.path, before: e.before, after: e.after }));
    const names = edits.map((e) => e.path.split("/").pop()).join(", ");
    this.push(`edit ${names}`, ops, "text:" + edits.map((e) => e.path).sort().join("|"));
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.run(e, true);
    this.redoStack.push(e);
    this.emit("state", this.state());
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.run(e, false);
    this.undoStack.push(e);
    this.emit("state", this.state());
    return e.label;
  }

  private run(e: Entry, undo: boolean): void {
    this.applying = true;
    try {
      for (const op of undo ? [...e.ops].reverse() : e.ops) this.apply(op, undo);
    } finally {
      this.applying = false;
    }
    this.emit("applied", { scene: e.ops.some((o) => o.kind === "scene") });
  }

  private apply(op: Op, undo: boolean): void {
    const p = this.project;
    switch (op.kind) {
      case "text": {
        const text = undo ? op.before : op.after;
        const abs = p.abs(op.path);
        if (text === null) {
          p.setSnapshot(op.path, null);
          if (existsSync(abs)) {
            const stash = this.stashPath(op.path);
            mkdirSync(dirname(stash), { recursive: true });
            renameSync(abs, stash);
          }
        } else {
          p.setSnapshot(op.path, text);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text);
        }
        break;
      }
      case "file": {
        const shouldExist = undo ? !op.present : op.present;
        const abs = p.abs(op.path);
        if (shouldExist && existsSync(op.stash) && !existsSync(abs)) {
          mkdirSync(dirname(abs), { recursive: true });
          if (p.isTextFile(op.path)) { try { p.setSnapshot(op.path, readFileSync(op.stash, "utf8")); } catch { /* directory */ } }
          renameSync(op.stash, abs);
        } else if (!shouldExist && existsSync(abs)) {
          mkdirSync(dirname(op.stash), { recursive: true });
          p.setSnapshot(op.path, null);
          renameSync(abs, op.stash);
        }
        break;
      }
      case "scene":
        p.setScene(undo ? op.before : op.after);
        break;
      case "placement":
        p.setPlacement(op.id, undo ? op.before : op.after);
        break;
    }
  }
}

/** Fold new text ops into an entry: keep the first "before", take the latest "after". */
function merge(entry: Entry, ops: Op[]): void {
  for (const op of ops) {
    const prev = op.kind === "text" ? entry.ops.find((o) => o.kind === "text" && o.path === op.path) : undefined;
    if (prev && prev.kind === "text" && op.kind === "text") prev.after = op.after;
    else entry.ops.push(op);
  }
}

function purgeTrash(dir: string): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - TRASH_DAYS * 86400_000;
  for (const n of names) {
    const abs = join(dir, n);
    try { if (statSync(abs).mtimeMs < cutoff) rmSync(abs, { recursive: true, force: true }); } catch { /* in use */ }
  }
}
