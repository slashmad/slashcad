// Local tool hub. The MCP stdio server (dist/mcp/server.js), started by Claude/Codex, connects here
// over a Unix socket / Windows named pipe and forwards tools/list and tools/call.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpActivity, ViewName } from "../shared/types";

export interface ToolContent { type: "text"; text: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ToolResult { content: (ToolContent | ImageContent)[]; isError?: boolean }

export interface ToolImpl {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: any): Promise<ToolResult>;
  summarize?(args: any, r: ToolResult): string;
}

const VIEWS: ViewName[] = ["iso", "front", "back", "left", "right", "top", "bottom", "current"];
export const VIEW_ENUM = VIEWS;

export class McpHub extends EventEmitter {
  readonly token: string;
  readonly address: string;
  private server: Server | null = null;
  private tools = new Map<string, ToolImpl>();

  /**
   * Stable address + persistent token, so a .mcp.json written for VS Code keeps working across
   * restarts. The single-instance lock guarantees one hub per user session.
   */
  constructor(stateDir: string, suffix = "") {
    super();
    const user = (process.env.USER || process.env.USERNAME || "user").replace(/[^a-zA-Z0-9_-]/g, "") + (suffix ? `-${suffix}-${process.pid}` : "");
    this.address = process.platform === "win32"
      ? `\\\\.\\pipe\\slashcad-${user}`
      : join(process.env.XDG_RUNTIME_DIR || tmpdir(), `slashcad-${user}.sock`);
    const tokenFile = join(stateDir, "mcp-token");
    let token = "";
    try { token = readFileSync(tokenFile, "utf8").trim(); } catch { /* first run */ }
    if (!/^[0-9a-f]{48}$/.test(token)) {
      token = randomBytes(24).toString("hex");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(tokenFile, token, { mode: 0o600 });
    }
    this.token = token;
  }

  register(name: string, impl: ToolImpl): void {
    this.tools.set(name, impl);
  }

  listTools() {
    return [...this.tools.entries()].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
  }

  async start(): Promise<void> {
    if (process.platform !== "win32" && existsSync(this.address)) unlinkSync(this.address);
    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.address, () => resolve());
    });
  }

  private onConnection(sock: Socket): void {
    let authed = false;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (msg.token !== this.token) { sock.destroy(); return; }
          authed = true;
          sock.write(JSON.stringify({ ok: true }) + "\n");
          continue;
        }
        const reply = (body: unknown) => sock.write(JSON.stringify({ id: msg.id, ...(body as object) }) + "\n");
        if (msg.op === "list") reply({ tools: this.listTools() });
        else if (msg.op === "call") reply({ result: await this.call(msg.name, msg.args ?? {}) });
      }
    });
    sock.on("error", () => {});
  }

  async call(name: string, args: any): Promise<ToolResult> {
    const t = this.tools.get(name);
    let r: ToolResult;
    if (!t) r = { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    else {
      try { r = await t.run(args); } catch (e: any) { r = { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true }; }
    }
    const firstText = r.content.find((c): c is ToolContent => c.type === "text")?.text ?? (r.content.some((c) => c.type === "image") ? "image" : "");
    const activity: McpActivity = { tool: name, args, ok: !r.isError, summary: t?.summarize?.(args, r) ?? firstText.split("\n")[0].slice(0, 160), ts: Date.now() };
    this.emit("activity", activity);
    return r;
  }

  /** Only the instance that owns the listening server may remove the socket file. */
  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    if (process.platform !== "win32" && existsSync(this.address)) { try { unlinkSync(this.address); } catch { /* gone */ } }
  }
}
