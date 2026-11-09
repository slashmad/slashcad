// Spike: drive the locally installed, unmodified Claude Code binary over stream-json.
// Measures: event types, token usage, rate-limit info, multi-turn over stdin,
// and permission prompts answered by the host (this script) instead of a TTY.
//
// Usage: node claude-spike.mjs <workdir> <logfile>
import { spawn } from "node:child_process";
import { readdirSync, existsSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function findClaude() {
  const extDir = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(extDir)
    .filter((d) => d.startsWith("anthropic.claude-code-") && d.endsWith("-linux-x64"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of dirs.reverse()) {
    const p = join(extDir, d, "resources", "native-binary", "claude");
    if (existsSync(p)) return p;
  }
  throw new Error("claude binary not found in VS Code extensions");
}

const [workdir, logfile] = process.argv.slice(2);
const log = createWriteStream(logfile);
const bin = findClaude();

// Never let an API key leak into the child: -p always prefers it over the subscription.
const env = { ...process.env };
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[k];

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", "haiku",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--tools", "Write",
  "--permission-prompts", "host",
  ...(process.env.SPIKE_PPT ? ["--permission-prompt-tool", process.env.SPIKE_PPT] : []),
  "--no-session-persistence",
];
const t0 = Date.now();
const child = spawn(bin, args, { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });

const prompts = [
  "Svara endast med ordet OK.",
  "Skapa filen hello.txt med innehållet hej. Använd verktyget Write. Svara sedan KLART.",
];
let turn = 0;
const counts = {};
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const sendPrompt = (text) =>
  send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    log.write(JSON.stringify({ t_ms: Date.now() - t0, raw: line }) + "\n");
    let ev;
    try { ev = JSON.parse(line); } catch { console.log("NON-JSON:", line.slice(0, 200)); continue; }
    const key = ev.type + (ev.subtype ? "/" + ev.subtype : "") + (ev.type === "stream_event" ? ":" + ev.event?.type : "");
    counts[key] = (counts[key] || 0) + 1;

    if (ev.type === "system" && ev.subtype === "init") {
      console.log(`[${Date.now() - t0}ms] init model=${ev.model} version=${ev.claude_code_version} perm=${ev.permissionMode} tools=${JSON.stringify(ev.tools)}`);
    } else if (ev.type === "control_request") {
      console.log(`[${Date.now() - t0}ms] control_request ${JSON.stringify(ev).slice(0, 400)}`);
      if (ev.request?.subtype === "can_use_tool") {
        send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: ev.request_id,
            response: { behavior: "allow", updatedInput: ev.request.input },
          },
        });
        console.log("  -> answered allow");
      }
    } else if (ev.type === "control_response") {
      console.log(`[${Date.now() - t0}ms] control_response ${JSON.stringify(ev).slice(0, 300)}`);
    } else if (ev.type === "rate_limit_event") {
      console.log(`[${Date.now() - t0}ms] rate_limit_event ${JSON.stringify(ev.rate_limit_info ?? ev)}`);
    } else if (ev.type === "result") {
      console.log(`[${Date.now() - t0}ms] result turn=${turn} subtype=${ev.subtype} text=${JSON.stringify(ev.result)} usage=${JSON.stringify(ev.usage)} modelUsage=${JSON.stringify(ev.modelUsage)} cost_est=${ev.total_cost_usd} denials=${JSON.stringify(ev.permission_denials)}`);
      turn++;
      if (turn < prompts.length) sendPrompt(prompts[turn]);
      else child.stdin.end();
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("STDERR: " + d));
child.on("exit", (code) => {
  console.log(`exit=${code} after ${Date.now() - t0}ms`);
  console.log("event counts:", JSON.stringify(counts, null, 1));
  log.end();
});
// The Agent SDK opens with an initialize control request; without it the CLI
// does not route permission prompts to the host.
if (process.env.SPIKE_NO_INIT) sendPrompt(prompts[0]);
else {
  send({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  child.stdout.once("data", () => sendPrompt(prompts[0]));
}
