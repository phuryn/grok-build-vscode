// Probe (agy 1.5.15 over ACP): two prompts that each read a file, so a turn makes more
// than one model call. Records every usage_update and tool_call with a timestamp and each
// prompt result's usage, to tell whether the result usage is one call or the turn's sum.
// Measured 2026-11-24: calls at 8,872 and 8,972, result input + cache read 17,748 (a sum).
// Refuses every server->client request (permissions, fs). Uses gemini-3.8-flash at low.
// Usage: node agy-multicall-usage-probe.cjs <scratch cwd containing notes.txt> <out.json>
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");

const cwd = process.argv[2];
const out = process.argv[3];
const child = spawn("agy", ["acp"], { cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
const seen = { steps: [], updates: [], stderr: "", errors: [] };
let buf = "";
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { seen.errors.push("non-json: " + line.slice(0, 200)); continue; }
    if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      const u = msg.params && msg.params.update;
      const kind = u && u.sessionUpdate;
      if (kind === "usage_update" || kind === "tool_call") seen.updates.push({ at: Date.now(), kind, used: u.used, title: u.title });
      if (msg.id !== undefined) {
        seen.errors.push("refused server request " + msg.method);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "probe" } }) + "\n");
      }
    }
  }
});
child.stderr.on("data", (d) => { seen.stderr += d.toString("utf8"); });

function summariseOptions(res) {
  const r = res && res.result;
  const opts = (r && r.configOptions) || [];
  return opts.map((o) => ({ id: o.id, current: o.currentValue, values: (o.options || []).map((v) => v.value) }));
}

function finish() {
  fs.writeFileSync(out, JSON.stringify(seen, null, 2));
  try { child.kill(); } catch {}
  if (process.platform === "win32" && child.pid) {
    try { execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" }); } catch {}
  }
  process.exit(0);
}

(async () => {
  const timer = setTimeout(() => { seen.errors.push("timeout"); finish(); }, 240000);
  await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const sn = await send("session/new", { cwd, mcpServers: [] });
  const sessionId = sn.result.sessionId;
  seen.steps.push({ step: "session/new", options: summariseOptions(sn) });

  const m = await send("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
  seen.steps.push({ step: "model=gemini-3.8-flash", error: m.error, options: summariseOptions(m) });
  const l = await send("session/set_config_option", { sessionId, configId: "thought_level", value: "low" });
  seen.steps.push({ step: "thought_level=low", error: l.error, options: summariseOptions(l) });

  for (const text of ["Use your file-reading tool to read notes.txt in the current folder, then reply with only its first word.", "Read notes.txt again with your tool and reply with only its last word."]) {
    const p = await send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    seen.steps.push({ at: Date.now(), step: "prompt: " + text, error: p.error, stopReason: p.result && p.result.stopReason, usage: p.result && p.result.usage, meta: p.result && p.result._meta });
  }
  clearTimeout(timer);
  setTimeout(finish, 1500);
})().catch((e) => { seen.errors.push(String(e && e.stack || e)); finish(); });
