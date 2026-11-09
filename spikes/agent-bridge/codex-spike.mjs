// Spike: drive the locally installed Codex CLI through `codex app-server` (JSONL over stdio).
// Measures: event types, token usage, rate limits, two turns, approval requests answered by the host.
//
// Usage: node codex-spike.mjs <workdir> <logfile>
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const [workdir, logfile] = process.argv.slice(2);
const log = createWriteStream(logfile);
const env = { ...process.env };
for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[k]; // stay on the ChatGPT login

const t0 = Date.now();
const ms = () => `${Date.now() - t0}ms`;
const codexBin = process.env.CODEX_BIN || "codex";
const child = spawn(codexBin, ["app-server"], { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 1;
const pending = new Map();
const counts = {};
const write = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    write({ id, method, params });
  });

let turnDone = null;
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    log.write(JSON.stringify({ t_ms: Date.now() - t0, raw: line }) + "\n");
    let m;
    try { m = JSON.parse(line); } catch { console.log("NON-JSON:", line.slice(0, 200)); continue; }

    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(`${p?.method}: ${JSON.stringify(m.error)}`));
      else p?.resolve(m.result);
      continue;
    }
    counts[m.method] = (counts[m.method] || 0) + 1;
    if (m.id !== undefined) {
      // Server -> client request (approvals, user input).
      console.log(`[${ms()}] server request ${m.method} ${JSON.stringify(m.params).slice(0, 400)}`);
      if (/Approval/.test(m.method)) {
        write({ id: m.id, result: { decision: "accept" } });
        console.log("  -> answered accept");
      }
      continue;
    }
    switch (m.method) {
      case "thread/tokenUsage/updated":
        console.log(`[${ms()}] tokenUsage ${JSON.stringify(m.params).slice(0, 500)}`);
        break;
      case "account/rateLimits/updated":
        console.log(`[${ms()}] rateLimits/updated ${JSON.stringify(m.params).slice(0, 400)}`);
        break;
      case "turn/diff/updated":
        console.log(`[${ms()}] turn/diff ${JSON.stringify(m.params).slice(0, 300)}`);
        break;
      case "item/completed":
        console.log(`[${ms()}] item/completed type=${m.params?.item?.type} ${JSON.stringify(m.params?.item).slice(0, 250)}`);
        break;
      case "turn/completed":
        console.log(`[${ms()}] turn/completed ${JSON.stringify(m.params).slice(0, 300)}`);
        turnDone?.();
        break;
      case "error":
        console.log(`[${ms()}] error ${JSON.stringify(m.params).slice(0, 400)}`);
        break;
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("STDERR: " + d));

async function turn(threadId, text) {
  const done = new Promise((r) => (turnDone = r));
  await request("turn/start", { threadId, input: [{ type: "text", text }], effort: "low" });
  await done;
}

try {
  const init = await request("initialize", { clientInfo: { name: "slashcad-spike", version: "0.0.1" } });
  console.log(`[${ms()}] initialize ${JSON.stringify(init).slice(0, 200)}`);
  write({ method: "initialized" });
  const acct = await request("account/read", {}).catch((e) => ({ error: String(e) }));
  console.log(`[${ms()}] account/read ${JSON.stringify(acct).slice(0, 200).replace(/"email":"[^"]*"/, '"email":"<redacted>"')}`);
  const rl = await request("account/rateLimits/read", {}).catch((e) => ({ error: String(e) }));
  console.log(`[${ms()}] rateLimits/read ${JSON.stringify(rl).slice(0, 500)}`);
  const th = await request("thread/start", {
    cwd: workdir,
    approvalPolicy: "on-request",
    sandbox: "read-only",
    ephemeral: true,
  });
  const threadId = th.thread?.id ?? th.threadId;
  console.log(`[${ms()}] thread/start id=${threadId} model=${th.model}`);
  await turn(threadId, "Svara endast med ordet OK.");
  await turn(threadId, "Skapa filen hello.txt med innehållet hej i arbetskatalogen. Svara sedan KLART.");
} catch (e) {
  console.log("FAILED:", e.message);
}
console.log(`done after ${ms()}`);
console.log("notification counts:", JSON.stringify(counts, null, 1));
child.stdin.end();
child.kill();
log.end();
