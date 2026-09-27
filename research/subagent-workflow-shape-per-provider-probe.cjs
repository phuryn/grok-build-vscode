// How does each agent put a SUBAGENT and a WORKFLOW on the ACP wire?
// Records every JSON-RPC frame, both directions, for one fresh session per
// demo, then (unless --no-load) session/loads the finished session in a fresh
// process and records the replay too.
//
// Usage (run `npm run compile` first; the probe reads out/):
//   node research/subagent-workflow-shape-per-provider-probe.cjs <provider> <demo> [--optin] [--no-load]
//     provider: grok | codex | claude | muse
//     demo:     subagent | subagent-noworkflow (same, but "not a workflow tool"; Muse reaches
//               for its workflow tool when asked for a subagent) | workflow |
//               workflow-tool (grok: model-launched inline script instead of /workflow <saved>)
//     --optin   also advertise the ACP subagent RFD (`clientCapabilities.subagents: {}`)
//               and JetBrains AIR `nativeSubagentSessions` + `asyncTasks`. The extension
//               sends neither today; codex-acp and claude-agent-acp gate their native
//               subagent/task surfaces on them.
//
// Output: research/subagent-workflow-shape-logs/<provider>-<demo>[-optin].jsonl — one line per
// frame: { seq, t, phase: "live"|"load", dir, msg }. dir is "c2a" (client -> agent),
// "a2c" (agent -> client), or for Muse "msp-s2a"/"msp-a2s" (the MSP stream under our own
// adapter, which the adapter does NOT forward). Email addresses and account ids are redacted.
//
// Spawning reuses the extension's own locators and backends (out/), exactly as the other
// *-per-provider probes do, with two deliberate differences: grok gets --no-leader (never
// attach to the owner's live leader), and every provider is asked for low reasoning effort
// through the backend's own setter so the trivial prompts stay trivially cheap.
//
// Muse runs IN-PROCESS: the adapter's own MuseSession (out/muse-adapter/session.mjs, the
// code main.mjs wraps in an ndjson stream) with the SDK's spawnMspConnection tapped, so one
// run yields both the ACP the extension would receive and the raw MSP underneath it.
//
// Safety policy (the CLIs are real and signed in):
// - session/request_permission: allow_once only for a subagent/workflow launcher or a
//   read/search/think tool; everything else (shell, edits, fetch, unknown) is reject_once.
//   Every decision is logged as a "probe" frame.
// - fs/read_text_file and fs/write_text_file are honoured only inside the scratch cwd.
// - terminal/create is always refused.
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const REPO = path.resolve(__dirname, "..");
const OUT = path.join(REPO, "out");
const argv = process.argv.slice(2);
const PROVIDER = (argv[0] || "").toLowerCase();
const DEMO = (argv[1] || "").toLowerCase();
const OPTIN = argv.includes("--optin");
const DO_LOAD = !argv.includes("--no-load");
if (!["grok", "codex", "claude", "muse"].includes(PROVIDER) || !["subagent", "subagent-noworkflow", "workflow", "workflow-tool"].includes(DEMO)) {
  console.error("usage: node research/subagent-workflow-shape-per-provider-probe.cjs grok|codex|claude|muse subagent|subagent-noworkflow|workflow|workflow-tool [--optin] [--no-load]");
  process.exit(2);
}

const LOG_DIR = path.join(__dirname, "subagent-workflow-shape-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const RUN_NAME = `${PROVIDER}-${DEMO}${OPTIN ? "-optin" : ""}`;
const LOG_FILE = path.join(LOG_DIR, RUN_NAME + ".jsonl");
fs.writeFileSync(LOG_FILE, "");
const T0 = Date.now();
let seq = 0;
let lastTraffic = Date.now();
let phase = "live";
const note = (s) => process.stderr.write(`[${RUN_NAME}] ${s}\n`);

// ---- redaction: this is a public repo; auth identity is not the subject ----
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_KEY = /^(email|emailAddress|accountUuid|accountId|account_id|organizationUuid|organizationId|organizationName|orgId|org_id|userId|user_id|apiKey|token|accessToken|refreshToken|authorization)$/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v != null && typeof v !== "object" ? "<redacted>" : redact(v);
    return out;
  }
  return typeof value === "string" ? value.replace(EMAIL, "<email>") : value;
}
function record(dir, msg) {
  lastTraffic = Date.now();
  const row = { seq: seq++, t: Date.now() - T0, phase, dir, msg: redact(msg) };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  return row;
}
const probeNote = (what, detail) => record("probe", { what, ...detail });

// ---- scratch workspace ----
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "swshape-" + PROVIDER + "-"));
fs.writeFileSync(path.join(cwd, "readme.md"), "subagent/workflow shape probe workspace\n");
if (PROVIDER === "grok" && DEMO === "workflow") {
  // Project workflows are discovered at <repo-root>/.grok/workflows/, keyed by meta.name.
  spawnSync("git", ["init", "-q", cwd]);
  fs.mkdirSync(path.join(cwd, ".grok", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".grok", "workflows", "shape-probe.rhai"), GROK_WORKFLOW_SCRIPT());
}
note("cwd=" + cwd + "  log=" + path.relative(REPO, LOG_FILE));

function GROK_WORKFLOW_SCRIPT() {
  return [
    "let meta = #{",
    '    name: "shape-probe",',
    '    description: "Two trivial one-word steps",',
    '    phases: [ #{ title: "One" }, #{ title: "Two" } ],',
    "};",
    'phase("One");',
    'let a = agent("Reply with exactly one word: alpha. Do not use any tools.", #{ label: "step-one", capability_mode: "read-only" });',
    'phase("Two");',
    'let b = agent("Reply with exactly one word: beta. Do not use any tools.", #{ label: "step-two", capability_mode: "read-only" });',
    'complete(#{ summary: "done", one: a.output, two: b.output });',
    "",
  ].join("\n");
}

const CLAUDE_WORKFLOW_SCRIPT = [
  "export const meta = { name: 'shape-probe', description: 'Two trivial one-word steps', phases: [{ title: 'One' }, { title: 'Two' }] }",
  "phase('One')",
  "const a = await agent('Reply with exactly one word: alpha. Do not use any tools.', { label: 'step-one', effort: 'low' })",
  "phase('Two')",
  "const b = await agent('Reply with exactly one word: beta. Do not use any tools.', { label: 'step-two', effort: 'low' })",
  "return { one: a, two: b }",
].join("\n");

const SUBAGENT_PROMPT =
  "Delegate this to a subagent using your own subagent / agent-spawning tool. Do not answer it yourself and do not use any other tools: " +
  "what is 2+2? The subagent should reply with just the number. Then reply to me with just that number.";
const GENERIC_WORKFLOW_PROMPT =
  "Do you have a workflow mechanism for deterministic multi-step / multi-agent orchestration (something other than spawning a single plain subagent)? " +
  "If you do, use it now to run the shortest possible two-step workflow: step one answers with exactly the word alpha, step two with exactly the word beta, " +
  "no tools inside the steps; then reply with the two words. If you have no such mechanism, reply exactly NO_WORKFLOW_MECHANISM followed by one sentence naming what you do have, and use no tools.";
function promptText() {
  if (DEMO === "subagent") return SUBAGENT_PROMPT;
  if (DEMO === "subagent-noworkflow") return SUBAGENT_PROMPT + " Use a plain subagent, not a workflow tool; if a plain subagent tool does not exist, say NO_PLAIN_SUBAGENT_TOOL and use no tools.";
  if (PROVIDER === "grok" && DEMO === "workflow") return "/workflow shape-probe";
  if (PROVIDER === "grok" && DEMO === "workflow-tool") {
    return "Use your workflow tool to launch this exact inline script (not saved, no validate_only), then stop. When its result arrives, reply with the two words.\n\n" + GROK_WORKFLOW_SCRIPT();
  }
  if (PROVIDER === "claude") {
    return "Use your Workflow tool (not the Agent tool) to run exactly this inline script, then reply with the two words it returns:\n\n" + CLAUDE_WORKFLOW_SCRIPT;
  }
  return GENERIC_WORKFLOW_PROMPT;
}

// ---- permission policy ----
const LAUNCHER = /spawn_subagent|spawn_agent|subagent|workflow|\bTask\b|\bAgent\b|delegate/i;
function permissionDecision(toolCall) {
  const kind = toolCall && toolCall.kind;
  const probe = JSON.stringify({ title: toolCall && toolCall.title, meta: toolCall && toolCall._meta,
    inputKeys: toolCall && toolCall.rawInput && typeof toolCall.rawInput === "object" ? Object.keys(toolCall.rawInput) : [] });
  if (["execute", "edit", "delete", "move", "fetch"].includes(kind)) return { allow: false, why: "kind " + kind };
  if (LAUNCHER.test(probe) && !/run_terminal_command|bash|shell/i.test(probe)) return { allow: true, why: "subagent/workflow launcher" };
  if (["read", "search", "think"].includes(kind)) return { allow: true, why: "read-only kind " + kind };
  return { allow: false, why: "unrecognised tool (kind " + kind + ")" };
}
function pickOption(options, allow) {
  const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of want) { const o = (options || []).find((x) => x.kind === k); if (o) return o; }
  return undefined;
}
function insideCwd(p) {
  const rel = path.relative(cwd, path.resolve(p));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---- capabilities: exactly what the extension sends, optionally plus the opt-ins ----
const { acpClientCapabilities } = require(path.join(OUT, "acp.js"));
function grokVersion(cli) {
  const r = spawnSync(cli, ["--version"], { encoding: "utf8" });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || "");
  return m ? m[1] : null;
}
function capabilities(cliPath) {
  const base = PROVIDER === "grok" ? acpClientCapabilities("grok", grokVersion(cliPath), true) : acpClientCapabilities(PROVIDER);
  if (!OPTIN) return base;
  return { ...base, subagents: {}, _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions", "asyncTasks"] } } } };
}

// ---- spawn spec from the extension's own locators + backends ----
function spawnSpec() {
  if (PROVIDER === "grok") {
    const { locateGrokCli } = require(path.join(OUT, "cli-locator.js"));
    const { grokBackend, buildGrokAgentArgs } = require(path.join(OUT, "grok-backend.js"));
    const cliPath = locateGrokCli("");
    if (!cliPath) return { missing: "grok CLI not found" };
    const spec = grokBackend.spawn({ cliPath, cwd, env: process.env, effort: "low" });
    const args = buildGrokAgentArgs("low");
    args.splice(1, 0, "--no-leader");
    return { cliPath, spec: { ...spec, args }, backend: grokBackend };
  }
  if (PROVIDER === "codex") {
    const { locateCodexCli } = require(path.join(OUT, "codex-cli-locator.js"));
    const { CodexBackend } = require(path.join(OUT, "codex-backend.js"));
    const cliPath = locateCodexCli({});
    if (!cliPath) return { missing: "codex CLI not found" };
    const backend = new CodexBackend({});
    return { cliPath, spec: backend.spawn({ cliPath, cwd, env: process.env }), backend };
  }
  const { locateClaudeCli } = require(path.join(OUT, "claude-cli-locator.js"));
  const { ClaudeBackend } = require(path.join(OUT, "claude-backend.js"));
  const cliPath = locateClaudeCli({});
  if (!cliPath) return { missing: "claude CLI not found" };
  const backend = new ClaudeBackend({});
  return { cliPath, spec: backend.spawn({ cliPath, cwd, env: process.env }), backend };
}

// ---- a raw JSON-RPC client over stdio, recording everything ----
function stdioClient(spec) {
  const proc = spawn(spec.command, spec.args, { cwd, env: spec.env, shell: spec.shell });
  const c = { proc, nextId: 1, waiters: new Map(), stderr: "" };
  proc.stderr.on("data", (d) => { c.stderr = (c.stderr + String(d)).slice(-20000); });
  const write = (obj) => { record("c2a", obj); proc.stdin.write(JSON.stringify(obj) + "\n"); };
  c.send = (method, params, timeoutMs = 120000) => {
    const id = c.nextId++;
    write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { c.waiters.delete(id); resolve({ error: { message: method + " timed out after " + timeoutMs + "ms" } }); }, timeoutMs);
      c.waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };
  c.notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { record("a2c-nonjson", { line: line.slice(0, 2000) }); return; }
    record("a2c", msg);
    if (msg.method && msg.id != null) return handleAgentRequest(msg, respond, fail);
    if (msg.id != null && c.waiters.has(msg.id)) { const w = c.waiters.get(msg.id); c.waiters.delete(msg.id); w(msg); }
  });
  c.exited = new Promise((resolve) => proc.on("close", (code) => resolve(code)));
  proc.on("error", (e) => { record("probe", { what: "spawn error", message: e.message }); });
  return c;
}

function handleAgentRequest(msg, respond, fail) {
  const m = msg.method, p = msg.params || {};
  if (m === "session/request_permission") {
    const d = permissionDecision(p.toolCall);
    const opt = pickOption(p.options, d.allow);
    probeNote("permission", { allow: d.allow, why: d.why, title: p.toolCall && p.toolCall.title, kind: p.toolCall && p.toolCall.kind, optionKind: opt && opt.kind });
    note(`permission ${d.allow ? "ALLOW" : "DENY"} (${d.why}): ${p.toolCall && p.toolCall.title}`);
    return respond(msg.id, opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } });
  }
  if (m === "fs/read_text_file") {
    if (!insideCwd(p.path)) { probeNote("fs read refused", { path: p.path }); return fail(msg.id, "probe: read outside scratch cwd refused"); }
    let content = ""; try { content = fs.readFileSync(p.path, "utf8"); } catch { return fail(msg.id, "not found"); }
    return respond(msg.id, { content });
  }
  if (m === "fs/write_text_file") {
    if (!insideCwd(p.path)) { probeNote("fs write refused", { path: p.path }); return fail(msg.id, "probe: write outside scratch cwd refused"); }
    fs.mkdirSync(path.dirname(p.path), { recursive: true }); fs.writeFileSync(p.path, p.content ?? "");
    return respond(msg.id, null);
  }
  if (m.startsWith("terminal/")) { probeNote("terminal refused", { method: m }); return fail(msg.id, "probe: shell execution refused"); }
  probeNote("unhandled agent request answered {}", { method: m });
  return respond(msg.id, {});
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
  else try { proc.kill("SIGKILL"); } catch {}
}
async function shutdown(c) {
  try { c.proc.stdin.end(); } catch {}
  const t = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
  if (t === "timeout") killTree(c.proc);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Background work (Grok workflows, async subagents) keeps talking after the prompt
// resolves. Linger until quiet: shorter after a terminal marker is seen.
const TERMINAL = /workflow_(completed|failed|cancelled)|"phase":"complete(d)?"|"result_summary":"[^"]|"subagent_finished"|"task_notification"|"kind":"workflow"[^\n]*"status":"(completed|failed|cancelled)"|"status":"(completed|failed|cancelled)"[^\n]*"kind":"workflow"/;
async function linger() {
  const isWorkflow = DEMO.startsWith("workflow");
  const start = Date.now();
  const maxMs = isWorkflow ? 360000 : 120000;
  let sawTerminal = false;
  const scan = () => {
    const tail = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-400).join("\n");
    if (TERMINAL.test(tail)) sawTerminal = true;
  };
  while (Date.now() - start < maxMs) {
    await sleep(2000);
    scan();
    const idle = Date.now() - lastTraffic;
    if (idle >= (sawTerminal ? 20000 : isWorkflow ? 90000 : 15000)) break;
  }
  probeNote("linger done", { ms: Date.now() - start, sawTerminal });
}

function summarize(label) {
  const rows = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.phase === label && (r.dir === "a2c" || r.dir === "msp-s2a"));
  const kinds = {}, sessions = new Set(), tools = new Map();
  for (const r of rows) {
    const m = r.msg; if (!m.method) continue;
    const key = (r.dir === "msp-s2a" ? "msp " : "") + (m.method === "session/update" ? "session/update:" + (m.params && m.params.update && m.params.update.sessionUpdate) : m.method)
      + (m.method === "item/started" || m.method === "item/completed" || m.method === "item/updated" ? ":" + (m.params.item && m.params.item.kind) : "");
    kinds[key] = (kinds[key] || 0) + 1;
    if (m.params && m.params.sessionId && r.dir === "a2c") sessions.add(m.params.sessionId);
    const u = m.params && m.params.update;
    if (u && (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")) {
      const prev = tools.get(u.toolCallId) || { sessionId: m.params.sessionId, frames: 0 };
      prev.frames++; if (u.title) prev.title = u.title; if (u.kind) prev.kind = u.kind; if (u.status) prev.status = u.status;
      if (u._meta) prev.metaKeys = Object.keys(u._meta);
      tools.set(u.toolCallId, prev);
    }
  }
  note(`=== ${label}: ${rows.length} agent frames; sessionIds=${JSON.stringify([...sessions])}`);
  note("kinds " + JSON.stringify(kinds));
  for (const [id, t] of tools) note(`tool ${id}: ${JSON.stringify(t)}`);
}

// ---- stdio providers ----
async function runStdio() {
  const located = spawnSpec();
  if (located.missing) { probeNote("not installed", { reason: located.missing }); note(located.missing); return; }
  const { cliPath, spec, backend } = located;
  probeNote("spawn", { cliPath, command: spec.command, args: spec.args });
  const caps = capabilities(cliPath);
  const A = stdioClient(spec);
  const init = await A.send("initialize", { protocolVersion: 1, clientCapabilities: caps });
  if (init.error) { note("initialize ERROR " + JSON.stringify(init.error)); note(A.stderr.slice(-1500)); killTree(A.proc); return; }
  const s = await A.send("session/new", { cwd, mcpServers: [] });
  if (s.error) { note("session/new ERROR " + JSON.stringify(s.error)); note(A.stderr.slice(-1500)); killTree(A.proc); return; }
  const sessionId = s.result.sessionId;
  note("session=" + sessionId);
  if (PROVIDER === "grok" && DEMO === "workflow") {
    // The saved-workflow catalog loads after session/new (an unsolicited `workflows-reload`
    // response); a launch before it answers "unknown workflow".
    const until = Date.now() + 10000;
    while (Date.now() < until && !fs.readFileSync(LOG_FILE, "utf8").includes('"id":"workflows-reload"')) await sleep(250);
    await sleep(1000);
  }
  if (PROVIDER !== "grok") {
    const eff = backend.setReasoningEffort(sessionId, undefined, "low");
    if (eff) { const r = await A.send(eff.method, eff.params); if (r.error) note("effort low rejected: " + JSON.stringify(r.error)); }
  }
  const pr = await A.send("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText() }] }, 600000);
  note("prompt result " + JSON.stringify(pr.result || pr.error));
  await linger();
  summarize("live");
  await shutdown(A);
  if (!DO_LOAD) return;
  await sleep(1500);
  phase = "load";
  const B = stdioClient(spec);
  const init2 = await B.send("initialize", { protocolVersion: 1, clientCapabilities: caps });
  if (init2.error) { note("load initialize ERROR"); killTree(B.proc); return; }
  const load = await B.send("session/load", { sessionId, cwd, mcpServers: [] }, 120000);
  if (load.error) note("session/load ERROR " + JSON.stringify(load.error));
  const quietStart = Date.now();
  while (Date.now() - quietStart < 30000 && Date.now() - lastTraffic < 5000) await sleep(500);
  summarize("load");
  await shutdown(B);
}

// ---- Muse: in-process adapter session with the MSP stream tapped ----
async function runMuse() {
  const { locateMuseCli } = require(path.join(OUT, "muse-cli-locator.js"));
  const { withMuseCredentialBackend } = require(path.join(OUT, "muse-backend.js"));
  const cliPath = locateMuseCli({});
  if (!cliPath) { probeNote("not installed", { reason: "muse CLI not found" }); note("muse CLI not found"); return; }
  Object.assign(process.env, withMuseCredentialBackend(process.env), { MUSE_CODE_EXECUTABLE: cliPath });
  process.chdir(cwd); // the adapter spawns `muse serve` in its own cwd, which the host sets to the workspace
  const sdk = await import("@muse-code/sdk");
  const { MuseSession } = await import(pathToFileURL(path.join(OUT, "muse-adapter", "session.mjs")).href);
  probeNote("spawn", { cliPath, adapter: "out/muse-adapter/session.mjs (in-process)" });
  let conn;
  const tappedSpawn = (options) => {
    const h = sdk.spawnMspConnection(options);
    const onN = h.onNotification.bind(h), onR = h.onServerRequest.bind(h), init = h.initialize.bind(h);
    h.onNotification = (cb) => onN((n) => { record("msp-s2a", { method: n.method, params: n.params }); return cb(n); });
    h.onServerRequest = (cb) => onR(async (req) => { record("msp-s2a", { request: true, method: req.method, params: req.params }); return cb(req); });
    h.initialize = async (params) => {
      record("msp-a2s", { method: "initialize", params });
      const spawned = await init(params);
      record("msp-s2a", { result: "initialize", value: spawned.initializeResult });
      conn = spawned.connection;
      for (const verb of ["request", "command"]) {
        const orig = conn[verb].bind(conn);
        conn[verb] = async (method, p, o) => {
          record("msp-a2s", { verb, method, params: p });
          try { const r = await orig(method, p, o); record("msp-s2a", { result: method, value: r }); return r; }
          catch (e) { record("msp-s2a", { error: method, message: String(e && e.message || e) }); throw e; }
        };
      }
      return spawned;
    };
    return h;
  };
  const acpClient = {
    notify: (method, params) => { record("a2c", { jsonrpc: "2.0", method, params }); return Promise.resolve(); },
    request: async (method, params) => {
      record("a2c", { jsonrpc: "2.0", id: "adapter", method, params });
      if (method !== "session/request_permission") { probeNote("unhandled agent request", { method }); return {}; }
      const d = permissionDecision(params.toolCall);
      const opt = pickOption(params.options, d.allow);
      probeNote("permission", { allow: d.allow, why: d.why, title: params.toolCall && params.toolCall.title, kind: params.toolCall && params.toolCall.kind });
      note(`permission ${d.allow ? "ALLOW" : "DENY"} (${d.why}): ${params.toolCall && params.toolCall.title}`);
      const result = opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
      record("c2a", { jsonrpc: "2.0", id: "adapter", result });
      return result;
    },
  };
  const call = async (label, fn) => {
    record("c2a", { method: label });
    try { const r = await fn(); record("a2c", { result: label, value: r }); return r; }
    catch (e) { record("a2c", { error: label, message: String(e && e.message || e) }); note(label + " ERROR " + (e && e.message)); return undefined; }
  };
  const fatal = (e) => { record("probe", { what: "adapter fatal", message: String(e && e.message || e) }); note("adapter fatal: " + (e && e.message)); };
  const logLine = (m) => record("adapter-log", { message: m });

  const A = new MuseSession(acpClient, logLine, fatal, tappedSpawn);
  if (!(await call("initialize", () => A.initialize().then(() => A.models())))) { await A.close().catch(() => {}); return; }
  const created = await call("session/new", () => A.newSession(cwd, []));
  if (!created) { await A.close().catch(() => {}); return; }
  const sessionId = created.sessionId;
  note("session=" + sessionId);
  await call("session/set_config_option reasoning_effort=low", () => A.setReasoningEffort(sessionId, "low"));
  if (conn) {
    // What the session offers as typed invocations (workflows may surface here).
    await conn.request("skill/list", { sessionId }).catch(() => {});
  }
  const pr = await call("session/prompt", () => A.prompt(sessionId, [{ type: "text", text: promptText() }]));
  note("prompt result " + JSON.stringify(pr));
  await linger();
  summarize("live");
  await A.close().catch((e) => note("close: " + e.message));
  if (!DO_LOAD) return;
  await sleep(1500);
  phase = "load";
  const B = new MuseSession(acpClient, logLine, fatal, tappedSpawn);
  await call("initialize", () => B.initialize());
  await call("session/load", () => B.loadSession(sessionId, cwd, []));
  await sleep(3000);
  summarize("load");
  await B.close().catch((e) => note("close: " + e.message));
}

(async () => {
  try {
    if (PROVIDER === "muse") await runMuse(); else await runStdio();
  } catch (e) {
    record("probe", { what: "probe crashed", message: String(e && e.stack || e) });
    note("CRASH " + (e && e.stack || e));
  }
  note("done -> " + path.relative(REPO, LOG_FILE));
  process.exit(0);
})();
