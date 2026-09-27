#!/usr/bin/env node
/**
 * On-demand LIVE pre-release smoke suite — spawns the REAL `grok agent stdio`
 * binary and exercises the surfaces the grok-free unit tests can't:
 * the actual ACP handshake, a prompt round-trip, a mid-turn session/cancel
 * (the Stop-button contract, #37), two concurrent sessions on one workspace
 * (the Agent Dashboard pool), session restore, plan-mode enforcement, and the
 * v1.4.0 features (image + video generation, subagents).
 *
 * Why this is NOT part of `npm test`:
 *   - CI has no `grok` binary, no login, and no SuperGrok subscription
 *     (`/imagine` is subscription-gated), so it literally can't run there.
 *   - Real LLM output is non-deterministic (whether grok delegates to a
 *     subagent, the exact tool sequence, the image content) — unassertable
 *     the way pure logic is, so it would flake the unit suite.
 *   - Spawning the binary + generating media is seconds-to-minutes and burns
 *     subscription credits.
 * So it's a manual gate: run `npm run test:live` before a release-to-main.
 *
 * It validates the REAL extension logic, not a re-implementation: it requires
 * the compiled `out/acp-dispatch.js` + `out/plan-gate.js` and the shipped
 * `media/webview-helpers.js`, and feeds genuine grok wire output through
 * `isMediaGenToolCall` / `extractGeneratedMediaPaths` / `isSubagentToolCall` /
 * `shouldBlockWrite` exactly as the extension does.
 *
 * Usage:
 *   npm run test:live                  # all tests
 *   npm run test:live -- --smoke       # fastest lane: handshake + capability-drift only (~5s)
 *   npm run test:live -- --quick       # skip the slow tests (plan-mode + image/video/subagent)
 *   npm run test:live -- --only=plan-mode,session-restore
 *   npm run test:live -- --only=video-gen          # video-gen is opt-in (off by default)
 *   npm run test:live -- --video-timeout=120000    # give /imagine-video 2 min before SKIPping
 *   GROK_BIN=/path/to/grok npm run test:live
 *
 * Exit code 0 iff no test FAILED (SKIPs — e.g. no subscription, grok chose not
 * to delegate — do not fail the gate; they're reported honestly).
 */
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// ── Real extension modules (compiled CJS + shipped webview helper) ───────────
const REPO = path.resolve(__dirname, "..");
let dispatch, planGate, helpers, acpMod;
try {
  dispatch = require(path.join(REPO, "out", "acp-dispatch.js"));
  planGate = require(path.join(REPO, "out", "plan-gate.js"));
  helpers = require(path.join(REPO, "media", "webview-helpers.js"));
  acpMod = require(path.join(REPO, "out", "acp.js"));
} catch (e) {
  console.error("Could not load compiled modules — run `npm run compile` (or `tsc -p .`) first.\n" + e.message);
  process.exit(2);
}
const { acpClientCapabilities } = acpMod;
const { isMediaGenToolCall, extractGeneratedMediaPaths, contextUsedFromCompactNotification, resolveModelId } = dispatch;
const { shouldBlockWrite } = planGate;
const { isSubagentToolCall, subagentLabel } = helpers;

// ── grok locator (cross-platform; mirrors cli-locator's resolution order) ────
function resolveGrok() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const win = process.platform === "win32";
  const candidates = win
    ? [path.join(home, ".grok", "bin", "grok.exe"), path.join(home, ".grok", "bin", "grok.cmd")]
    : [path.join(home, ".grok", "bin", "grok")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return win ? "grok.exe" : "grok"; // last resort: rely on PATH
}
const GROK = resolveGrok();
const GROK_HOME = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".grok");

// ── CLI flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes("=") ? f.split("=")[1] : undefined; };
const QUICK = !!flag("quick");
// --smoke: the fastest lane — handshake + capability drift only (no prompt turns).
// A ~5s "is grok alive and still advertising what we expect" pre-flight to run often
// during dev; the full gate (and --quick) still cover the behavioral tests.
const SMOKE = !!flag("smoke");
const ONLY = (flagVal("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const SKIP = (flagVal("skip") || "").split(",").map((s) => s.trim()).filter(Boolean);
let liveOutput, liveScenario = "startup";
function liveEvidence() {
  if (!liveOutput) {
    const parent = path.join(REPO, ".verification", "acp-smoke");
    fs.mkdirSync(parent, { recursive: true });
    liveOutput = fs.mkdtempSync(path.join(parent, "grok-live-"));
  }
  return liveOutput;
}
function recordLive(direction, message) {
  fs.appendFileSync(path.join(liveEvidence(), "grok-wire.jsonl"), JSON.stringify({ at: new Date().toISOString(), scenario: liveScenario, direction, message }) + "\n");
}
// /imagine-video works interactively, but in this bare headless harness grok
// 0.2.x tends to spin (Glob/Grep + the video tool retrying with status:failed)
// instead of cleanly producing one clip, so it often never finishes regardless
// of how long we wait — a longer cap doesn't help (10 min timed out just like
// 5). So testVideo treats a timeout as an inconclusive SKIP, not a FAIL, and the
// wait is just "give it a fair chance before giving up." Override with
// --video-timeout=<ms> or GROK_VIDEO_TIMEOUT_MS.
const VIDEO_TIMEOUT_MS = Number(flagVal("video-timeout") || process.env.GROK_VIDEO_TIMEOUT_MS) || 300000;

// ── A minimal ACP client over one grok child process ─────────────────────────
// Spawns `grok agent stdio`, frames newline-delimited JSON-RPC, auto-answers
// the mandatory server→client requests, and records writes + media/subagent
// tool calls so each test can assert against real wire output.
class Acp {
  constructor(cwd, { extraArgs = [], onWrite, onExitPlan } = {}) {
    this.cwd = cwd;
    this.nextId = 1;
    this.waiters = new Map();
    this.updates = [];
    this.writes = [];        // every fs/write_text_file path grok asked for
    this.exitPlans = [];     // every x.ai/exit_plan_mode request grok raised
    this.mediaGenIds = new Set();
    this.media = [];         // MediaRef[] from the real extractor
    this.subagentCalls = []; // tool calls the real isSubagentToolCall matched (genuine spawn_subagent shape)
    this.bgTasks = [];       // background tasks grok spawned (its real subagent mechanism)
    this.taskOutputCalls = []; // get_command_or_subagent_output poller tool_calls
    this.lifecycle = [];     // subagent_spawned/subagent_finished (method _x.ai/session/update)
    this.xaiNotifs = [];     // LIVE rail: _x.ai/session_notification updates (auto_compact_completed, subagent_*, turn_completed, …) — the method the extension consumes
    this.onWrite = onWrite;  // optional per-test hook (path) => "write" | "ack"
    this.onExitPlan = onExitPlan; // optional synchronous hook (params, count) => native outcome
    this.buf = "";
    const win = process.platform === "win32";
    const useShell = /\.(cmd|bat)$/i.test(GROK);
    this.proc = spawn(GROK, [...extraArgs, "agent", "stdio"], {
      cwd, env: process.env, shell: useShell && win,
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (/error|panic|unauthor|forbidden|subscription/i.test(s)) this.lastStderr = s.slice(0, 300);
    });
    this.proc.on("exit", (c) => { this.exitCode = c; });
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { recordLive("wire-error", { line }); continue; }
      this._handle(m);
    }
  }

  _handle(m) {
    recordLive("receive", m);
    if (m.id != null && m.method == null) {            // response to one of our requests
      const w = this.waiters.get(m.id);
      if (w) { this.waiters.delete(m.id); w(m); }
      return;
    }
    if (m.method === "session/update") {
      const u = m.params && m.params.update;
      if (u) { this.updates.push(u); this._inspectUpdate(u); }
      return;
    }
    if (m.method === "_x.ai/session/update" || m.method === "x.ai/session/update") {
      // Persist/replay rail — recorded for the subagent tests' historical check.
      const u = m.params && m.params.update;
      if (u) this.lifecycle.push(u);
      if (m.id != null) this._respond(m.id, {});
      return;
    }
    if (m.method === "_x.ai/session_notification" || m.method === "x.ai/session_notification") {
      // LIVE lifecycle rail — the method the extension's AcpClient handles
      // (acp.ts → xaiNotification). Carries auto_compact_completed / subagent_* /
      // turn_completed. Record so the notification-consumer features have a real
      // release gate against CLI drift.
      const u = m.params && m.params.update;
      if (u) this.xaiNotifs.push(u);
      if (m.id != null) this._respond(m.id, {});
      return;
    }
    if (m.method && m.id != null) this._serverRequest(m);  // server→client request
  }

  // Mirror of AcpClient.emitToolMedia + the subagent classifier so the test
  // measures exactly what the extension would surface.
  _inspectUpdate(u) {
    const t = u.sessionUpdate;
    if (t !== "tool_call" && t !== "tool_call_update") return;
    const id = u.toolCallId;
    if (isMediaGenToolCall(u) && typeof id === "string") this.mediaGenIds.add(id);
    if (typeof id === "string" && this.mediaGenIds.has(id)) {
      this.media.push(...extractGeneratedMediaPaths(u));
    }
    if (t === "tool_call" && isSubagentToolCall(u)) this.subagentCalls.push(u);
    // grok's REAL subagent mechanism on the native build is a *background*
    // run_terminal_command + a get_command_or_subagent_output poller (there is
    // no spawn_subagent tool — see research/subagents.md). Track both so the
    // test can confirm a delegation happened AND that the poller is NOT carded.
    const ri = u.rawInput || {};
    const title = String(u.title || "");
    if (ri.is_background === true || ri.background === true || /^\[bg\]/.test(title)) this.bgTasks.push(u);
    if (t === "tool_call" && (ri.variant === "TaskOutput" || /subagent_output|task output/i.test(title))) this.taskOutputCalls.push(u);
  }

  _serverRequest(m) {
    const meth = m.method;
    if (meth === "fs/read_text_file") {
      let content = ""; try { content = fs.readFileSync(m.params.path, "utf8"); } catch {}
      return this._respond(m.id, { content });
    }
    if (meth === "fs/write_text_file") {
      this.writes.push(m.params.path);
      const action = this.onWrite ? this.onWrite(m.params.path, m.params.content) : "write";
      if (action === "write") {
        try { fs.mkdirSync(path.dirname(m.params.path), { recursive: true }); fs.writeFileSync(m.params.path, m.params.content || ""); } catch {}
      }
      return this._respond(m.id, {});
    }
    if (meth === "terminal/create") return this._respond(m.id, { terminalId: "t" + this.nextId });
    if (meth === "terminal/output") return this._respond(m.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    if (meth === "terminal/wait_for_exit") return this._respond(m.id, { exitCode: 0 });
    if (meth === "terminal/kill" || meth === "terminal/release") return this._respond(m.id, {});
    if (meth.includes("exit_plan_mode")) {
      this.exitPlans.push(m.params || {});
      const outcome = this.onExitPlan
        ? this.onExitPlan(m.params || {}, this.exitPlans.length)
        : "approved";
      return this._respond(m.id, { outcome });
    }
    if (meth === "session/request_permission") {
      const opts = (m.params && m.params.options) || [];
      const allow = opts.find((o) => /allow/.test(o.kind)) || opts[0];
      return this._respond(m.id, { outcome: { outcome: "selected", optionId: allow && allow.optionId } });
    }
    if (/ask_user_question/.test(meth)) return this._respond(m.id, { outcome: "cancelled" });
    return this._respond(m.id, {});
  }

  send(method, params) {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((res) => this.waiters.set(id, res));
  }
  // Id-less notification — session/cancel MUST go out this way (the extension's
  // AcpClient.cancel() does the same; grok ignores it when sent as a request).
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  _respond(id, result) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }

  agentText() {
    return this.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text")
      .map((u) => u.content.text).join("");
  }
  kill() { try { this.proc.kill(); } catch {} }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function readGrokVersionBanner() {
  try {
    const win = process.platform === "win32";
    const useShell = /\.(cmd|bat)$/i.test(GROK);
    return String(require("node:child_process").execFileSync(GROK, ["--version"], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      shell: useShell && win,
    }) || "").trim();
  } catch {
    return "";
  }
}
const GROK_VERSION = readGrokVersionBanner();
// Same selection the extension ships (`acpClientCapabilities`). A live
// grok >= 1.0.4 withholds readTextFile; 0.2.117 / unreadable keeps the
// delegated handshake. Plan/rewind/edit then exercise the production wire,
// not a leftover client-delegated filesystem.
const INIT = { protocolVersion: 1, clientCapabilities: acpClientCapabilities("grok", GROK_VERSION, true) };
const READ_TEXT_FILE_ADVERTISED = INIT.clientCapabilities.fs.readTextFile === true;
function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), "grok-live-" + tag + "-")); }
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms))]);
}
/** Poll `cond` every 50ms until truthy; throws after `ms`. For "mid-turn" timing
 *  (e.g. cancel once the stream starts flowing). */
async function waitFor(cond, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout after ${ms}ms waiting for: ${label}`);
}
class Skip extends Error {}        // throw to mark a test SKIPPED (not failed)
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── tests ────────────────────────────────────────────────────────────────────
// Each returns a short detail string on success, throws Error to FAIL, or
// throws Skip to mark inconclusive (e.g. no subscription / grok didn't delegate).

// #46: agent shell host. The extension — not grok — runs every terminal/* call,
// so which shell it uses is our choice. This is the one entry that doesn't spawn
// grok: it drives the REAL compiled `out/terminal-manager.js` the extension ships
// against the actual OS shell, proving on Windows that a grok-issued command runs
// under PowerShell (pwsh → powershell), where a PowerShell-only pipeline + cmdlet
// succeed that cmd.exe would have failed. On POSIX it confirms $SHELL (or
// /bin/sh) is the host. Deterministic (we issue the commands), so it's a real release gate.
async function testTerminalShell() {
  let TerminalManager, resolveTerminalShell, posixShellFromEnv;
  try {
    ({ TerminalManager, resolveTerminalShell, posixShellFromEnv } = require(path.join(REPO, "out", "terminal-manager.js")));
  } catch (e) {
    throw new Skip("out/terminal-manager.js not built — run `npm run compile` (" + e.message + ")");
  }
  const which = (name) => {
    if (process.platform !== "win32") return undefined;
    try {
      const out = require("node:child_process").execFileSync("where", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const first = out.split(/\r?\n/)[0]?.trim();
      return first && fs.existsSync(first) ? first : undefined;
    } catch {
      return undefined;
    }
  };
  const shell = resolveTerminalShell(process.platform, which, "auto", process.env.SHELL);

  const m = new TerminalManager();
  const run = async (command) => {
    const { terminalId } = m.create({ command });
    const { exitCode } = await m.waitForExit(terminalId);
    const output = m.output(terminalId).output.trim();
    return { exitCode, output };
  };

  try {
    if (process.platform !== "win32") {
      const expected = posixShellFromEnv(process.env.SHELL);
      assert(shell === expected, `POSIX host should be $SHELL or /bin/sh, got ${JSON.stringify(shell)}`);
      const r = await run("printf '%s' OK_POSIX");
      assert(r.exitCode === 0 && /OK_POSIX/.test(r.output), `POSIX command failed: ${JSON.stringify(r)}`);
      return `POSIX host = ${shell === true ? "/bin/sh" : shell}; command ran`;
    }

    // Windows: must resolve to a PowerShell, never cmd.exe.
    assert(shell !== true, "Windows resolved to cmd.exe (shell:true) — no PowerShell on PATH?");
    const shellName = path.basename(String(shell)).toLowerCase();
    assert(/^(pwsh|powershell)\.exe$/.test(shellName), `unexpected Windows host shell: ${shell}`);

    const pipe = await run("'a','b','c' | Measure-Object | ForEach-Object { $_.Count }");
    assert(pipe.exitCode === 0 && pipe.output.includes("3"), `PS pipeline failed under ${shellName}: ${JSON.stringify(pipe)}`);

    const ver = await run("$PSVersionTable.PSVersion.Major");
    assert(ver.exitCode === 0 && /^\d+$/.test(ver.output), `$PSVersionTable failed: ${JSON.stringify(ver)}`);

    const fmt = await run("[pscustomobject]@{ RepoRoot = 'demo' } | Format-List");
    assert(fmt.exitCode === 0 && /RepoRoot/.test(fmt.output) && /demo/.test(fmt.output), `Format-List pipe failed: ${JSON.stringify(fmt)}`);

    return `Windows host = ${shellName} (PowerShell ${ver.output}); pipeline + cmdlet + Format-List all ran (cmd.exe would fail these)`;
  } finally {
    m.disposeAll();
  }
}

async function testHandshake() {
  const cwd = mkTmp("hs");
  const acp = new Acp(cwd);
  try {
    const init = await withTimeout(acp.send("initialize", INIT), 30000, "initialize");
    assert(!init.error, "initialize errored: " + JSON.stringify(init.error));
    const r = init.result || {};
    assert(r.protocolVersion != null || r.agentCapabilities || r.promptCapabilities, "no capabilities in initialize result");
    const caps = r.agentCapabilities || r.promptCapabilities || {};
    return `protocolVersion=${r.protocolVersion}, caps=${Object.keys(caps).join("|") || "?"}, advertised=${JSON.stringify(INIT.clientCapabilities.fs)}`;
  } finally { acp.kill(); }
}

// CLI-drift resilience: the extension carries workarounds for the CLI *lying* about
// its own capabilities — most notably `promptCapabilities.image:false` while the CLI
// actually accepts image blocks (research/vision-input.md). This probe pins the
// ADVERTISEMENT; the `vision-prompt` test pins the ACTUAL behavior. Together they're
// an advertised-vs-actual drift detector: the day grok flips `image` to true (or
// changes what it advertises), this FAILs with an actionable message so the workaround
// gets re-verified/removed instead of silently rotting. Handshake-only, so it's cheap
// enough to run in every gate (and in the --smoke lane).
async function testCapabilities() {
  const cwd = mkTmp("caps");
  const acp = new Acp(cwd);
  try {
    const init = await withTimeout(acp.send("initialize", INIT), 30000, "initialize");
    assert(!init.error, "initialize errored: " + JSON.stringify(init.error));
    const caps = (init.result && init.result.agentCapabilities && init.result.agentCapabilities.promptCapabilities) || {};
    // Documented baseline (research/vision-input.md): image:false, audio:false,
    // embeddedContext:true — captured against 0.2.87. We only hard-assert `image`
    // (the one that gates a real workaround); the rest ride along in the detail so
    // any change is visible in the PASS line.
    assert(
      caps.image === false,
      `DRIFT: grok advertises promptCapabilities.image=${JSON.stringify(caps.image)} (baseline: false). ` +
      "If it's now true, the image:false workaround (research/vision-input.md + the vision-prompt gate) " +
      "may be removable — re-verify vision behavior and update this baseline.",
    );
    return `promptCapabilities=${JSON.stringify(caps)} — image:false baseline holds (vision-prompt pins that vision works anyway)`;
  } finally { acp.kill(); }
}

async function testPrompt() {
  const cwd = mkTmp("prompt");
  const acp = new Acp(cwd);
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;
    const pr = await withTimeout(
      acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly one word: PONG. No tools, no explanation." }] }),
      120000, "session/prompt");
    assert(!pr.error, "prompt errored: " + JSON.stringify(pr.error));
    const text = acp.agentText();
    assert(text.trim().length > 0, "no agent_message_chunk text came back");
    const pong = /pong/i.test(text);
    // grok ≥0.2.33 echoes the live prompt back as a user_message_chunk — the very
    // behavior that doubled every sent message before the host gated forwarding to
    // replay-only. Surface the count so a future version dropping it is visible.
    const liveEchoes = acp.updates.filter((u) => u.sessionUpdate === "user_message_chunk").length;
    return `stopReason=${pr.result && pr.result.stopReason}, replied ${text.trim().length} chars${pong ? " (contains PONG)" : ""}, live-echo×${liveEchoes}`;
  } finally { acp.kill(); }
}

// The Stop button contract (#37). The extension cancels a turn by sending
// session/cancel as an id-less notification mid-stream; the CLI must (a) settle
// the in-flight session/prompt with a cancelled stopReason — not hang it, not
// error it, not kill the process — and (b) keep the session usable for the next
// prompt (the extension keeps the same process after Stop). #37 showed how much
// rides on cancel semantics: an unexpected cancel resolves running tools as
// "cancelled by the user", so a drift here changes user-visible behavior.
async function testCancelMidTurn() {
  const cwd = mkTmp("cancel");
  const acp = new Acp(cwd);
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    // A long generation, cancelled the moment the stream starts flowing.
    const pending = acp.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Write a detailed 1500-word essay on the history of version control systems. No tools, no files — just prose." }],
    });
    await waitFor(
      () => acp.updates.some((u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk"),
      90000, "first streamed chunk before cancel",
    );
    acp.notify("session/cancel", { sessionId });

    const res = await withTimeout(pending, 30000, "prompt settlement after session/cancel");
    const stop = res.result && res.result.stopReason;
    assert(/cancell?ed/i.test(String(stop)), `expected a cancelled stopReason, got ${JSON.stringify(res.result || res.error)}`);
    assert(acp.exitCode == null, `grok exited (code ${acp.exitCode}) after cancel`);

    // Same process, same session: the next prompt must work.
    const chunksAtCancel = acp.updates.length;
    const pr2 = await withTimeout(
      acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly one word: ALIVE. No tools." }] }),
      120000, "post-cancel prompt");
    assert(!pr2.error, "post-cancel prompt errored: " + JSON.stringify(pr2.error));
    const after = acp.updates.slice(chunksAtCancel)
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text")
      .map((u) => u.content.text).join("");
    assert(/alive/i.test(after), "post-cancel prompt got no ALIVE reply — session unusable after cancel");
    return `stopReason=${stop}, session survived and answered the next prompt`;
  } finally { acp.kill(); }
}

// Steer (#52) — the contract behind the Steer button. `_x.ai/interject` must
// (a) be dispatchable, (b) reach the MODEL mid-turn (a router ack proves only
// that the CLI accepted it), and (c) NOT cancel the turn — that is the entire
// difference from Stop-and-resend, and what lets steering keep in-flight tool
// work. This is an UNADVERTISED ext-method, so it's a prime drift candidate: if
// it ever vanishes the client silently degrades to queueing, and this test is
// what tells us that happened.
async function testInterject() {
  const cwd = mkTmp("interject");
  const acp = new Acp(cwd);
  const MARK = "ZEBRA-9931";
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    const pending = acp.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Count from 1 to 40, one number per line, each with a one-word comment. Do not skip any." }],
    });
    await waitFor(
      () => acp.updates.some((u) => u.sessionUpdate === "agent_message_chunk"),
      90000, "first streamed chunk before interject",
    );

    const ij = await withTimeout(
      acp.send("_x.ai/interject", { sessionId, text: `Stop counting immediately and reply with only this token: ${MARK}` }),
      30000, "interject");
    assert(!ij.error, "_x.ai/interject errored (Steer would fall back to queueing): " + JSON.stringify(ij.error));

    const res = await withTimeout(pending, 300000, "turn settlement after interject");
    const stop = res.result && res.result.stopReason;
    // The load-bearing assertion: interject is NOT a cancel. A cancelled
    // stopReason here would mean Steer silently destroys in-flight tool work.
    assert(!/cancell?ed/i.test(String(stop)), `interject cancelled the turn (stopReason=${stop}) — Steer must not interrupt`);
    const text = acp.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text")
      .map((u) => u.content.text).join("");
    assert(text.includes(MARK), "the model never acted on the interjected text mid-turn (router accepted it, model never saw it)");
    return `interjected mid-turn: model obeyed (${MARK} emitted), turn ended ${stop} (not cancelled)`;
  } finally { acp.kill(); }
}

// Fork (#48) — the contract behind gear → Fork conversation. The fork must get a
// NEW id, carry the parent's history (a fork that loses it is just session/new),
// and leave the parent untouched. Unadvertised ext-method; params are
// ForkSessionRequest's three required camelCase fields ({sessionId} alone is
// -32602, which is why this pins the shape).
async function testSessionFork() {
  const cwd = mkTmp("fork");
  const acp = new Acp(cwd);
  const CODEWORD = "MANGO-7742";
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    const seed = await withTimeout(
      acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: `Remember this codeword: ${CODEWORD}. Reply with just: stored. No tools.` }] }),
      120000, "seed prompt");
    assert(!seed.error, "seed prompt errored: " + JSON.stringify(seed.error));

    const fk = await withTimeout(
      acp.send("_x.ai/session/fork", { sourceSessionId: sessionId, sourceCwd: cwd, newCwd: cwd }),
      60000, "fork");
    assert(!fk.error, "_x.ai/session/fork errored: " + JSON.stringify(fk.error));
    const newId = fk.result && fk.result.newSessionId;
    assert(newId && newId !== sessionId, `fork returned no new id (${JSON.stringify(fk.result)})`);
    assert(fk.result.chatMessagesCopied > 0, "fork copied no chat messages — the fork would start empty");

    // The fork must actually be loadable AND remember the parent's conversation.
    const ld = await withTimeout(acp.send("session/load", { sessionId: newId, cwd, mcpServers: [] }), 120000, "load fork");
    assert(!ld.error, "session/load on the fork errored: " + JSON.stringify(ld.error));
    const at = acp.updates.length;
    const recall = await withTimeout(
      acp.send("session/prompt", { sessionId: newId, prompt: [{ type: "text", text: "What codeword did I ask you to remember? Reply with just the codeword. No tools." }] }),
      120000, "fork recall");
    assert(!recall.error, "fork recall prompt errored: " + JSON.stringify(recall.error));
    const said = acp.updates.slice(at)
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text")
      .map((u) => u.content.text).join("");
    assert(said.includes(CODEWORD), `the fork lost the parent's history (recall: ${JSON.stringify(said.slice(0, 80))})`);
    return `forked ${sessionId.slice(0, 8)} → ${newId.slice(0, 8)} (${fk.result.chatMessagesCopied} msgs), fork recalled the parent's codeword`;
  } finally { acp.kill(); }
}

// Worktree lifecycle (P2-8): the sidebar's New/Apply/Remove flow, end-to-end
// against real grok — create an isolated git worktree via the unadvertised
// `_x.ai/git/worktree/create`, confirm it via `list`, merge it back via `apply`,
// and clean it up via `remove` (then confirm it's gone). Reuses the SHIPPED pure
// parsers (out/worktree.js), so it tests the wire→parser path the extension runs,
// not a re-implementation. SKIPs on -32601 — a pre-worktree CLI, where the
// extension degrades to "unsupported" rather than erroring.
async function testWorktree() {
  const wt = require(path.join(REPO, "out", "worktree.js"));
  const execFileSync = require("node:child_process").execFileSync;
  const cwd = mkTmp("wt");
  const acp = new Acp(cwd);
  try {
    // A worktree source must be a git repo with at least one commit.
    const git = (args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "seed"]);

    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    const cr = await withTimeout(
      acp.send("_x.ai/git/worktree/create", { sessionId, sourcePath: cwd, label: "livetest" }),
      60000, "worktree create");
    if (cr.error && cr.error.code === -32601) throw new Skip("CLI has no _x.ai/git/worktree/* (pre-worktree build) — extension degrades to unsupported");
    assert(!cr.error, "worktree create errored: " + JSON.stringify(cr.error));
    const created = wt.parseWorktreeCreate(cr.result);
    assert(created && created.worktreePath, "create returned no worktreePath: " + JSON.stringify(cr.result));
    const worktreePath = created.worktreePath;
    // create is async: it returns status "creating" with the path, and the actual
    // checkout appears once the `_x.ai/git/worktree/status` "created" work finishes.
    await waitFor(() => fs.existsSync(worktreePath), 30000, `worktree checkout on disk (${worktreePath})`);

    // Registration in the CLI's worktree db can lag the checkout dir, so poll.
    let records = [];
    const listDeadline = Date.now() + 20000;
    while (Date.now() < listDeadline) {
      const ls = await withTimeout(acp.send("_x.ai/git/worktree/list", {}), 30000, "worktree list");
      assert(!ls.error, "worktree list errored: " + JSON.stringify(ls.error));
      records = wt.parseWorktreeList(ls.result);
      if (records.some((w) => wt.pathsEqual(w.path, worktreePath))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert(records.some((w) => wt.pathsEqual(w.path, worktreePath)),
      `created worktree not in list (${records.length} records: ${JSON.stringify(records.map((w) => w.path)).slice(0, 200)})`);

    // Apply merges edits back; with no edits it still succeeds (empty file set).
    const ap = await withTimeout(acp.send("_x.ai/git/worktree/apply", { sessionId, worktreePath }), 60000, "worktree apply");
    assert(!ap.error, "worktree apply errored: " + JSON.stringify(ap.error));
    assert(wt.parseWorktreeApply(ap.result), "apply returned no result: " + JSON.stringify(ap.result));

    // No process holds the worktree as cwd here, so remove should clean up.
    const rm = await withTimeout(acp.send("_x.ai/git/worktree/remove", { worktreePath }), 60000, "worktree remove");
    assert(!rm.error, "worktree remove errored: " + JSON.stringify(rm.error));
    const removed = wt.parseWorktreeRemove(rm.result);
    assert(removed && removed.removed, "remove did not report removed: " + JSON.stringify(rm.result));

    const ls2 = await withTimeout(acp.send("_x.ai/git/worktree/list", {}), 30000, "worktree list 2");
    const after = wt.parseWorktreeList(ls2.result);
    assert(!after.some((w) => wt.pathsEqual(w.path, worktreePath)), "worktree still listed after remove");

    return `create→list→apply→remove OK (${path.basename(worktreePath)}; ${records.length}→${after.length} worktrees)`;
  } finally { acp.kill(); }
}

// Rewind (P2-9): the gear/Rewind flow end-to-end against real grok — list the
// rewind points, dry-run an execute (the CLI's confirmation gate: success:false,
// no mutation), then a real `conversation_only` + force rewind (truncates chat,
// touches NO files on disk). Reuses the SHIPPED parsers (out/rewind.js). SKIPs on
// -32601 — a pre-rewind CLI, where the extension degrades to "unsupported".
async function testRewind() {
  const rw = require(path.join(REPO, "out", "rewind.js"));
  const cwd = mkTmp("rewind");
  const acp = new Acp(cwd);
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    // Seed two turns so there are rewind points (one per user prompt).
    for (const t of ["Say only: one. No tools.", "Say only: two. No tools."]) {
      const p = await withTimeout(acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] }), 120000, "seed");
      assert(!p.error, "seed prompt errored: " + JSON.stringify(p.error));
    }

    const pts = await withTimeout(acp.send("_x.ai/rewind/points", { sessionId }), 30000, "rewind points");
    if (pts.error && pts.error.code === -32601) throw new Skip("CLI has no _x.ai/rewind/* (pre-rewind build) — extension degrades to unsupported");
    assert(!pts.error, "rewind points errored: " + JSON.stringify(pts.error));
    const points = rw.parseRewindPoints(pts.result);
    assert(points.length >= 1, `no rewind points parsed (${JSON.stringify(pts.result).slice(0, 160)})`);
    const target = points[0].promptIndex;

    // Dry-run (no force): the CLI's confirmation gate — parses, mutates nothing.
    const dry = await withTimeout(acp.send("_x.ai/rewind/execute", { sessionId, targetPromptIndex: target, mode: "conversation_only" }), 30000, "rewind dry-run");
    assert(!dry.error, "rewind dry-run errored: " + JSON.stringify(dry.error));
    assert(rw.parseRewindExecute(dry.result), "dry-run execute did not parse: " + JSON.stringify(dry.result));

    // Real conversation-only rewind (force) — truncates chat, touches NO files.
    const ex = await withTimeout(acp.send("_x.ai/rewind/execute", { sessionId, targetPromptIndex: target, mode: "conversation_only", force: true }), 30000, "rewind execute");
    assert(!ex.error, "rewind execute errored: " + JSON.stringify(ex.error));
    const res = rw.parseRewindExecute(ex.result);
    assert(res && res.success, "rewind execute did not report success: " + JSON.stringify(ex.result));

    return `points(${points.length}) → dry-run + conversation_only rewind to #${target} OK`;
  } finally { acp.kill(); }
}

// Rewind FILE RESTORE (P2-9) — the risky half: rewinding reverts code on disk.
// Have grok actually edit a file (0.2.x: the harness performs
// fs/write_text_file; 1.x: grok writes the file itself), then rewind with
// mode "all" + force and assert the file is restored to its pre-edit contents.
// Disposable temp git repo. SKIPs if grok doesn't take the file-edit path
// (non-deterministic) or the CLI lacks rewind (-32601).
async function testRewindFiles() {
  const rw = require(path.join(REPO, "out", "rewind.js"));
  const execFileSync = require("node:child_process").execFileSync;
  const cwd = mkTmp("rewindfiles");
  const acp = new Acp(cwd);
  try {
    const git = (args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(["init", "-q"]); git(["config", "user.email", "t@t.t"]); git(["config", "user.name", "t"]);
    const file = path.join(cwd, "foo.txt");
    const ORIGINAL = "ORIGINAL LINE\n";
    fs.writeFileSync(file, ORIGINAL);
    git(["add", "-A"]); git(["commit", "-qm", "seed"]);

    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(!r.error && r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;

    // Ask grok to overwrite foo.txt. Under the delegated handshake the harness
    // writes it; on 1.x grok writes it itself. Either way the file changes
    // and grok snapshots a rewind point for the turn.
    const edit = await withTimeout(acp.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Use your file-editing tool to replace the ENTIRE contents of foo.txt with exactly this one line:\nMODIFIED LINE\nThen stop. Do not run any shell commands." }],
    }), 180000, "edit prompt");
    assert(!edit.error, "edit prompt errored: " + JSON.stringify(edit.error));

    const afterEdit = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!/MODIFIED/.test(afterEdit)) throw new Skip("grok did not edit foo.txt via the file tool (chose another path) — nothing to restore");

    const pts = await withTimeout(acp.send("_x.ai/rewind/points", { sessionId }), 30000, "rewind points");
    if (pts.error && pts.error.code === -32601) throw new Skip("CLI has no _x.ai/rewind/* (pre-rewind build)");
    assert(!pts.error, "rewind points errored: " + JSON.stringify(pts.error));
    const points = rw.parseRewindPoints(pts.result);
    assert(points.length >= 1, `no rewind points (${JSON.stringify(pts.result).slice(0, 120)})`);
    const target = points[points.length - 1].promptIndex; // the edit turn's point (snapshot is pre-edit)

    // Rewind with file restore (mode "all" + force) → foo.txt must revert.
    const ex = await withTimeout(acp.send("_x.ai/rewind/execute", { sessionId, targetPromptIndex: target, mode: "all", force: true }), 60000, "rewind execute");
    assert(!ex.error, "rewind execute errored: " + JSON.stringify(ex.error));
    const res = rw.parseRewindExecute(ex.result);
    assert(res && res.success, "rewind execute not success: " + JSON.stringify(ex.result));

    const restored = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    assert(restored === ORIGINAL, `file NOT restored to original — got ${JSON.stringify(restored.slice(0, 40))} (revertedFiles=${JSON.stringify(res.revertedFiles)})`);

    return `grok edited foo.txt → rewind(mode=all,#${target}) restored it (revertedFiles=${res.revertedFiles.length})`;
  } finally { acp.kill(); }
}

// The Agent Dashboard runs a pool of live sessions — one `grok agent stdio`
// process each, same workspace (#37's reporter ran several concurrently). Two
// processes serving overlapping prompts must complete independently: no
// cross-talk, no contention on the shared ~/.grok session store.
async function testParallelSessions() {
  const cwd = mkTmp("pool");
  const a = new Acp(cwd);
  const b = new Acp(cwd);
  try {
    const [ia, ib] = await Promise.all([
      withTimeout(a.send("initialize", INIT), 30000, "init A"),
      withTimeout(b.send("initialize", INIT), 30000, "init B"),
    ]);
    assert(!ia.error && !ib.error, "initialize errored");
    const [na, nb] = await Promise.all([
      withTimeout(a.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new A"),
      withTimeout(b.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new B"),
    ]);
    assert(na.result && na.result.sessionId, "session/new A failed: " + JSON.stringify(na.error));
    assert(nb.result && nb.result.sessionId, "session/new B failed: " + JSON.stringify(nb.error));
    assert(na.result.sessionId !== nb.result.sessionId, "both processes returned the same session id");

    const [pa, pb] = await Promise.all([
      withTimeout(a.send("session/prompt", { sessionId: na.result.sessionId, prompt: [{ type: "text", text: "Reply with exactly one word: ALPHA. No tools." }] }), 180000, "prompt A"),
      withTimeout(b.send("session/prompt", { sessionId: nb.result.sessionId, prompt: [{ type: "text", text: "Reply with exactly one word: BRAVO. No tools." }] }), 180000, "prompt B"),
    ]);
    assert(!pa.error, "prompt A errored: " + JSON.stringify(pa.error));
    assert(!pb.error, "prompt B errored: " + JSON.stringify(pb.error));
    const ta = a.agentText(), tb = b.agentText();
    assert(/alpha/i.test(ta), "session A missing its own reply");
    assert(/bravo/i.test(tb), "session B missing its own reply");
    assert(!/bravo/i.test(ta) && !/alpha/i.test(tb), `cross-talk between concurrent sessions (A="${ta.trim().slice(0, 40)}", B="${tb.trim().slice(0, 40)}")`);
    return `two concurrent processes answered independently (A→ALPHA, B→BRAVO)`;
  } finally { a.kill(); b.kill(); }
}

// Vision INPUT (paste/upload → inline {type:"image"} blocks in session/prompt).
// This wire surface is invisible to every grok-free layer: the CLI still
// ADVERTISES promptCapabilities.image:false but actually accepts image blocks
// (verified on 0.2.87 — see research/vision-input.md), so only a live check can
// catch a build that starts rejecting them (the audio precedent: -32602 killed
// the whole turn). A solid 256×256 red PNG is generated in-process; the model
// answering "red" proves the pixels — not just the [Image #1] tag — got through.
async function testVisionPrompt() {
  const zlib = require("node:zlib");
  function crc32(buf) {
    let c; const table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }
  const n = 256;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3).fill(Buffer.from([255, 0, 0]))]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: n }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  const cwd = mkTmp("vision");
  const acp = new Acp(cwd);
  try {
    const init = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!init.error, "init errored");
    const advertised = init.result?.agentCapabilities?.promptCapabilities?.image;
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    const pr = await withTimeout(
      acp.send("session/prompt", {
        sessionId: ns.result.sessionId,
        prompt: [
          { type: "text", text: "What is the dominant color of this image? Reply with just the color name, one word. No tools.\n\n[Image #1]" },
          { type: "image", mimeType: "image/png", data: png.toString("base64") },
        ],
      }),
      120000, "vision prompt");
    assert(!pr.error, "vision prompt REJECTED (capability drift? was accepted on 0.2.87): " + JSON.stringify(pr.error));
    const text = acp.agentText();
    assert(/red/i.test(text), `model did not see the image (advertised image:${advertised}); replied: ${text.trim().slice(0, 120)}`);
    return `model saw the pixels (answered red); advertised promptCapabilities.image=${advertised}`;
  } finally { acp.kill(); }
}

async function testRestore() {
  const cwd = mkTmp("restore");
  const MARK = "ZEBRA-RESTORE-CHECK";
  // 1) fresh process: make a session and put a recognizable exchange in it
  const a = new Acp(cwd);
  let sessionId;
  try {
    await withTimeout(a.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(a.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    sessionId = ns.result.sessionId;
    await withTimeout(a.send("session/prompt", { sessionId, prompt: [{ type: "text", text: `Remember this codeword and reply with just the word: ${MARK}` }] }), 120000, "seed prompt");
  } finally { a.kill(); }
  await new Promise((r) => setTimeout(r, 800)); // let grok flush the session to disk

  // 2) brand-new process: load that session and assert the history replays
  const b = new Acp(cwd);
  try {
    await withTimeout(b.send("initialize", INIT), 30000, "init2");
    const load = await withTimeout(b.send("session/load", { sessionId, cwd, mcpServers: [] }), 60000, "session/load");
    assert(!load.error, "session/load errored: " + JSON.stringify(load.error));
    const replay = b.updates
      .filter((u) => /message_chunk/.test(u.sessionUpdate))
      .map((u) => (u.content && u.content.text) || "").join("\n");
    assert(b.updates.length > 0, "session/load produced no replay updates");
    assert(replay.includes(MARK), `replay did not contain the seeded codeword (got ${b.updates.length} updates)`);
    return `loaded ${sessionId.slice(0, 8)}…, replayed ${b.updates.length} updates incl. codeword`;
  } finally { b.kill(); }
}

// #30: an edit's "open diff →" preview must survive a session restore. It's built
// from a `content:[{type:"diff", oldText, newText}]` block on the edit's tool call.
// grok delivers that block on DIFFERENT messages by path — LIVE on a follow-up
// `tool_call_update` (the `tool_call` is a bare "StrReplace" with no content), but
// on session/load REPLAY the whole edit collapses into a single completed
// `tool_call` that carries the diff itself. media/chat.js now extracts diffs from
// BOTH message kinds. This asserts the wire the fix relies on: an edit both live
// AND on reload must surface a structured diff. A DOM test can't catch a drift
// here — it can only assume a shape (the original #30 test assumed the wrong one).
function editDiffUpdate(updates) {
  return updates.find((u) =>
    (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
    Array.isArray(u.content) && u.content.some((c) => c && c.type === "diff" && (c.oldText != null || c.newText != null)));
}
async function testEditDiffRestore() {
  const cwd = mkTmp("editdiff");
  const file = path.join(cwd, "note.md");
  const MARK = "<!-- DELETE-ME-LINE -->";
  fs.writeFileSync(file, `# Note\n\n${MARK}\n\nKeep this line.\n`);

  // 1) fresh process: have grok remove the marker line (a single edit).
  const a = new Acp(cwd);
  let sessionId, liveDiff;
  try {
    await withTimeout(a.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(a.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    sessionId = ns.result.sessionId;
    await withTimeout(a.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `In note.md, delete the line containing \`${MARK}\`. Make just that one edit. Do not explain.` }],
    }), 120000, "edit prompt");
    liveDiff = editDiffUpdate(a.updates);
  } finally { a.kill(); }

  if (!liveDiff) throw new Skip("grok did not emit a structured edit diff live (chose a different edit path) — nothing to assert on restore");
  await new Promise((r) => setTimeout(r, 800)); // let grok flush the session to disk

  // 2) brand-new process: load the session and assert the replayed edit STILL
  // carries the structured diff (the regression: it used to arrive only on the
  // completed tool_call, which chat.js didn't inspect for diffs).
  const b = new Acp(cwd);
  try {
    await withTimeout(b.send("initialize", INIT), 30000, "init2");
    const load = await withTimeout(b.send("session/load", { sessionId, cwd, mcpServers: [] }), 60000, "session/load");
    assert(!load.error, "session/load errored: " + JSON.stringify(load.error));
    await new Promise((r) => setTimeout(r, 400)); // drain trailing replay updates
    const replayDiff = editDiffUpdate(b.updates);
    assert(replayDiff, `restore dropped the structured edit diff the "open diff" preview needs (replay had ${b.updates.length} updates, none an edit with type:diff content) — #30 regression`);
    return `edit diff present live (${liveDiff.sessionUpdate}) and on restore (${replayDiff.sessionUpdate})`;
  } finally { b.kill(); }
}

// Plan mode uses the CLI's native verdict result. State changes happen in the
// exit_plan_mode handler before its response releases grok's continuation.
//
// Two separate signals are tracked, per the plan-mode research:
//   A. in-workspace ACP write *attempts* while the gate is up = model discipline
//      (grok tried to implement) — informational, and only populated under the
//      delegated handshake (0.2.x). On 1.x writes are not delegated; an empty
//      acp.writes list is the shipped behaviour, not a miss.
//   B. disk mutation before the rejected verdict = a CONTAINMENT failure. On
//      0.2.x that means a write path the harness did not mediate; on 1.x Plan
//      file safety rests on grok's native edit refusal. The hard assertion is
//      the seed-file canary either way.
// Rewind/Edit contract (#56 + P2-9), exercised over the shape that actually
// broke in dogfooding: repeated no-op plans, each CANCELLED.
//
// Why plans specifically — Cancel now abandons each plan inside its original
// prompt turn. The bubble -> rewind-point map must therefore stay one-to-one;
// legacy primer/marker filtering remains covered by the offline rewind tests.
//
// Pins three things that were each wrong at some point:
//   1. execute DISCARDS its target (Edit must target the message ITSELF —
//      targeting the predecessor silently ate an extra turn);
//   2. the tip is a legal target (so the newest message is editable at all);
//   3. hidden plumbing points never consume a bubble slot.
//
// Runs against the SHIPPED out/rewind.js, so CLI drift fails the gate here.
async function testPlanCancelRewind() {
  const rw = require(path.join(REPO, "out", "rewind.js"));
  const cwd = mkTmp("plancancel");
  const acp = new Acp(cwd, {
    onWrite: () => "ack", // plan mode: never touch disk
    onExitPlan: () => "abandoned",
  });
  const ROUNDS = 3;
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    const sessionId = ns.result.sessionId;

    await withTimeout(acp.send("session/set_mode", { sessionId, modeId: "plan" }), 30000, "set_mode plan");

    for (let i = 1; i <= ROUNDS; i++) {
      await withTimeout(acp.send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text:
          "No-op plan test " + i + ": present a trivial plan that changes nothing. Do not edit files." }],
      }), 180000, "plan turn " + i);
      // Native `abandoned` ends the original turn; re-enter Plan for the next round.
      if (i < ROUNDS) {
        await withTimeout(acp.send("session/set_mode", { sessionId, modeId: "plan" }), 30000, "set_mode plan " + (i + 1));
      }
    }

    const pts = await withTimeout(acp.send("_x.ai/rewind/points", { sessionId }), 30000, "points");
    if (pts.error && pts.error.code === -32601) throw new Skip("CLI has no _x.ai/rewind/*");
    assert(!pts.error, "rewind points errored: " + JSON.stringify(pts.error));
    const points = rw.parseRewindPoints(pts.result);
    const facing = rw.userFacingRewindPoints(points);

    // ROUNDS original plan messages -> ROUNDS bubbles; no synthetic verdict turns.
    assert(facing.length === ROUNDS,
      "bubble map wrong: " + facing.length + " user-facing of " + points.length +
      " points, expected " + ROUNDS + " (previews: " +
      facing.map((p) => JSON.stringify(String(p.promptPreview || "").slice(0, 24))).join(",") + ")");

    // (2) the newest bubble is editable, and (1) it targets its OWN point.
    const tipTarget = rw.resolveEditRewindTarget(points, ROUNDS - 1);
    assert(tipTarget, "Edit unavailable on the newest message (tip not a legal target?)");
    assert(tipTarget.promptIndex === facing[ROUNDS - 1].promptIndex,
      "Edit target #" + tipTarget.promptIndex + " != its own point #" + facing[ROUNDS - 1].promptIndex);

    // Editing the FIRST message targets its own point and removes that turn only.
    const firstTarget = rw.resolveEditRewindTarget(points, 0);
    assert(firstTarget && firstTarget.promptIndex === facing[0].promptIndex,
      "Edit on the first message must target its own point");
    assert(rw.survivingUserMessagesAfterRewind(points, facing[0]) === 0,
      "rewinding the first message should leave 0 user messages");

    // Execute against the MIDDLE bubble and prove the target itself is gone.
    const target = facing[1];
    const surviving = rw.survivingUserMessagesAfterRewind(points, target);
    assert(surviving === 1, "surviving=" + surviving + ", expected 1");
    const ex = await withTimeout(acp.send("_x.ai/rewind/execute", {
      sessionId, targetPromptIndex: target.promptIndex, mode: "conversation_only", force: true,
    }), 60000, "execute");
    const res = rw.parseRewindExecute(ex.result);
    assert(res && res.success, "rewind execute failed: " + JSON.stringify(ex.result || ex.error));
    // The CLI hands back the DISCARDED message's text (why a client can restore it).
    assert(typeof res.promptText === "string" && res.promptText.length > 0,
      "execute returned no prompt_text to restore");

    const after = rw.parseRewindPoints(
      (await withTimeout(acp.send("_x.ai/rewind/points", { sessionId }), 30000, "points2")).result);
    assert(!after.some((p) => p.promptIndex === target.promptIndex),
      "target #" + target.promptIndex + " SURVIVED — execute switched to keep-semantics; " +
      "Edit/Rewind are now off by one and will eat an extra turn");
    const afterFacing = rw.userFacingRewindPoints(after);
    assert(afterFacing.length === surviving,
      "after rewind " + afterFacing.length + " bubbles remain, expected " + surviving);

    return ROUNDS + " plan+cancel rounds -> " + points.length + " points/" + facing.length +
      " bubbles (plumbing filtered); exit_plan_mode x" + acp.exitPlans.length +
      "; execute DISCARDED #" + target.promptIndex + " (" + facing.length + " -> " +
      afterFacing.length + " bubbles), prompt_text returned";
  } finally { acp.kill(); }
}

// Per-turn billing is the extension's own bookkeeping: grok reports usage per
// prompt and persists NONE of it, so a session total only exists because we log
// each turn. A rewind then has to SUBTRACT the discarded turns — which is only
// possible if every turn really carries its own distinct measurement.
//
// This is the drift canary for that assumption. If the CLI ever stops sending
// `_meta.usage`, or starts sending a cumulative figure instead of a per-turn
// one, summing the log would silently over-bill and rewind subtraction would go
// negative-ish. Both failures are invisible in the UI, so they get asserted here.
async function testUsagePerTurn() {
  const cwd = mkTmp("usage");
  const acp = new Acp(cwd);
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    const sessionId = ns.result.sessionId;

    const turns = [];
    for (const t of ["Say only: ONE. No tools.", "Say only: TWO. No tools."]) {
      const r = await withTimeout(acp.send("session/prompt", {
        sessionId, prompt: [{ type: "text", text: t }],
      }), 120000, "prompt");
      assert(!r.error, "prompt errored: " + JSON.stringify(r.error));
      turns.push(dispatch.extractPromptMeta(r.result)); // the shipped extractor
    }

    for (let i = 0; i < turns.length; i++) {
      assert(turns[i] && turns[i].usage,
        "turn " + (i + 1) + " carried no _meta.usage — per-turn billing is gone, " +
        "session totals and rewind subtraction both break");
      assert(dispatch.usageIsRealMeasurement(turns[i]),
        "turn " + (i + 1) + " usage is not a real measurement (totalTokens===0?)");
    }

    // Each turn must be its OWN measurement, not a running total: if turn 2
    // already contained turn 1, summing the log would double-bill.
    const t1 = turns[0].usage, t2 = turns[1].usage;
    const total = dispatch.sumUsage(turns.map((m) => ({ usage: m.usage })));
    assert(total && total.inputTokens === (t1.inputTokens || 0) + (t2.inputTokens || 0),
      "sumUsage != turn1+turn2 — the log doesn't add up");
    // The cumulative-drift canary. `t2 < total` would be a tautology (total is
    // t1+t2), so it proves nothing — the tell is the RATIO. Both prompts are
    // two words against the same system prompt, so per-turn reporting keeps
    // turn 2 within a few percent of turn 1 (the conversation grew by ~2 short
    // messages on ~15k tokens). If the CLI switched to a running total, turn 2
    // would contain turn 1 as well and land near 2x. 1.6x sits far from both.
    const t1In = t1.inputTokens || 0;
    const t2In = t2.inputTokens || 0;
    assert(t1In > 0 && t2In > 0, "a turn reported 0 input tokens — usage is not being measured");
    // Normalize by modelCalls: a turn that needed two model calls re-sends the
    // conversation twice, so raw input per TURN legitimately doubles (observed:
    // 31669 for a 2-call turn vs 15979 for a 1-call turn). Comparing raw totals
    // would fail whenever grok happened to take an extra call. Input per CALL is
    // the stable quantity — both prompts are two words against the same system
    // prompt, so it barely moves; under cumulative reporting turn 2 would carry
    // turn 1 as well and jump.
    const perCall = (u) => (u.inputTokens || 0) / Math.max(1, u.modelCalls || 1);
    const ratio = perCall(t2) / perCall(t1);
    assert(ratio < 1.6,
      "turn 2 input/call is " + ratio.toFixed(2) + "x turn 1 (" +
      Math.round(perCall(t2)) + " vs " + Math.round(perCall(t1)) + " per call; raw " +
      t2In + " vs " + t1In + ", calls " + (t2.modelCalls || "?") + " vs " + (t1.modelCalls || "?") +
      ") — usage looks CUMULATIVE, not per-turn. Summing our usageLog would over-bill, " +
      "and a rewind could not subtract a discarded turn. Both are invisible in the UI.");

    // The rewind contract, on real numbers: drop turn 2, get turn 1's total back.
    const afterRewind = dispatch.sumUsage([{ usage: t1 }]);
    assert(afterRewind.inputTokens === t1.inputTokens,
      "re-summing a truncated log did not reproduce turn 1's billing");

    return "per-turn usage distinct (t1 in=" + t1.inputTokens + "/" + (t1.modelCalls || "?") +
      " calls, t2 in=" + t2.inputTokens + "/" + (t2.modelCalls || "?") + " calls, " +
      "input-per-call ratio " + ratio.toFixed(2) + "x, total in=" + total.inputTokens +
      "); truncating to turn 1 restores its own figure";
  } finally { acp.kill(); }
}

async function testPlanMode() {
  const cwd = mkTmp("plan");
  const appPath = path.join(cwd, "app.js");
  const seed = "function add(a,b){return a+b}\nmodule.exports={add}\n";
  fs.writeFileSync(appPath, seed);

  // The gate is a SOFT choke point on ACP-mediated writes: ack (don't write)
  // in-workspace writes only while it's up; perform everything else for real (grok
  // reads its own session-dir plan.md back mid-turn, so a blanket ack makes it spin).
  // `gateUp` flips exactly where the real extension raises/lowers it.
  let gateUp = true;
  const inWs = (p) => { const rel = path.relative(cwd, p); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
  const diskMutated = () => { try { return fs.readFileSync(appPath, "utf8") !== seed; } catch { return true; } };
  let rejectedClean = false;
  let rejectedAttempts = 0;
  const acp = new Acp(cwd, {
    onWrite: (p) => (inWs(p) ? (gateUp ? "ack" : "write") : "write"),
    onExitPlan: (_params, count) => {
      if (count === 1) {
        assert(!diskMutated(), "CONTAINMENT: app.js changed before the rejected verdict");
        rejectedClean = true;
        rejectedAttempts = acp.writes.filter(inWs).length;
        return "cancelled";
      }
      // Mirror handleExitPlan: lower the gate before releasing native approval.
      gateUp = false;
      return "approved";
    },
  });
  const wsAttempts = () => acp.writes.filter(inWs).length;

  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    const sessionId = ns.result.sessionId;

    const sm = await withTimeout(acp.send("session/set_mode", { sessionId, modeId: "plan" }), 30000, "set_mode plan");
    assert(!sm.error, "set_mode plan errored: " + JSON.stringify(sm.error));

    // ── Phase 1: PLAN (gate up) ──────────────────────────────────────────────
    // grok ≥0.2.91's plan flow is long even when healthy (~4 min: reads its docs,
    // keeps session-dir state, may delegate to a planning subagent) — real PASSes
    // have clocked 305-315s, and a slow-backend night tips a 6-min ceiling into a
    // false FAIL. 10 min keeps the timeout a hang detector, not a latency bet.
    const turn = await withTimeout(
      acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Plan how to add a subtract(a,b) function to app.js and a test for it. Produce a detailed plan; do not implement yet." }] }),
      600000, "plan prompt");
    assert(!turn.error, "plan turn errored: " + JSON.stringify(turn.error));

    const upCtx = { active: true, workspaceRoot: cwd, grokHome: GROK_HOME };
    assert(shouldBlockWrite(appPath, upCtx) === true, "plan-gate failed to block an in-workspace write while up");
    const planFile = path.join(GROK_HOME, "sessions", "enc", sessionId, "plan.md");
    assert(shouldBlockWrite(planFile, upCtx) === false, "plan-gate wrongly blocked grok's own plan.md");
    assert(rejectedClean, "grok never requested the rejected native verdict");

    // Whether a `cancelled` verdict makes grok re-plan IN THE SAME TURN is NOT a
    // guarantee — measured on 0.2.117 across identical prompts it produced 1, 2 and
    // 15 same-turn re-asks. This assertion used to require >=2 and failed the night
    // it came back 1. Both outcomes are correct product behaviour: grok either
    // revises unprompted, or ends the turn and waits for the user (who gets the
    // "staying in Plan mode" notice and types what to change). So drive the second
    // case the way a user would, rather than pinning a model coin-flip.
    const spontaneousReplan = acp.exitPlans.length >= 2;
    if (!spontaneousReplan) {
      const revise = await withTimeout(
        acp.send("session/prompt", { sessionId, prompt: [{ type: "text",
          text: "Revise the plan to also reject non-number arguments, then ask for approval again." }] }),
        600000, "revise prompt");
      assert(!revise.error, "revise turn errored: " + JSON.stringify(revise.error));
    }

    // What IS guaranteed, and what this test exists for: cancelled contains every
    // workspace mutation, and approval lowers the gate before implementation runs.
    assert(acp.exitPlans.length >= 2,
      "grok never re-asked for approval, even when prompted to revise (exit requests: " + acp.exitPlans.length + ")");
    assert(gateUp === false, "approval did not lower the client gate before continuation");
    const downCtx = { active: false, workspaceRoot: cwd, grokHome: GROK_HOME };
    assert(shouldBlockWrite(appPath, downCtx) === false, "plan-gate still blocked an in-workspace write after approval");
    const landed = diskMutated();
    assert(landed, "native approval did not land the implementation inside the original turn");

    if (!READ_TEXT_FILE_ADVERTISED) {
      assert(acp.writes.length === 0,
        "grok 1.x delegated fs/write_text_file despite withheld readTextFile — write independence changed; " +
        "plan-gate.ts is no longer unreachable on this handshake");
    }

    const wrotePlan = acp.writes.some((w) => /plan\.md$/i.test(w));
    return `native cancelled → ${spontaneousReplan ? "same-turn re-plan" : "turn ended, user-prompted revision"} → approved (${acp.exitPlans.length} exit requests); ${rejectedAttempts} pre-reject workspace attempt(s) contained; gate lowered before implementation; ${wsAttempts()} total workspace write request(s)${READ_TEXT_FILE_ADVERTISED ? "" : " (none expected: 1.x withheld readTextFile)"}, implementation landed${wrotePlan ? "; grok kept its own plan.md" : ""}`;
  } finally { acp.kill(); }
}

async function testImage() {
  const cwd = mkTmp("img");
  const acp = new Acp(cwd);
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    const pr = await withTimeout(
      acp.send("session/prompt", { sessionId: ns.result.sessionId, prompt: [{ type: "text", text: "/imagine a small red cube on a white background" }] }),
      180000, "/imagine");
    if (pr.error) throw new Skip("/imagine errored (likely no subscription): " + JSON.stringify(pr.error));
    const imgs = acp.media.filter((m) => m.media === "image");
    if (imgs.length === 0) {
      if (/subscription|unauthor|forbidden|upgrade/i.test(acp.lastStderr || acp.agentText())) throw new Skip("image generation unavailable (subscription/auth)");
      throw new Skip("grok produced no image (the model declined or the feature is gated) — agent said: " + acp.agentText().slice(0, 120));
    }
    const ref = imgs[0];
    assert(fs.existsSync(ref.path), "extractor returned an image path that doesn't exist on disk: " + ref.path);
    const bytes = fs.statSync(ref.path).size;
    assert(bytes > 1000, "generated image file is suspiciously small: " + bytes + " bytes");
    return `image at ${path.basename(ref.path)} (${(bytes / 1024).toFixed(0)} KB), classified media:"image"`;
  } finally { acp.kill(); }
}

// What was grok last seen doing? Used to make a video-gen timeout self-explain:
// "in_progress with a media-gen tool call" = slow-but-working; "no tool calls" =
// stuck/idle (a different problem worth chasing).
function videoProgress(acp) {
  const tc = acp.updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
  const titles = [...new Set(tc.map((u) => u.title).filter(Boolean))].slice(0, 4);
  const statuses = [...new Set(tc.map((u) => u.status).filter(Boolean))];
  return `grok emitted ${acp.updates.length} update(s), ${acp.mediaGenIds.size} media-gen tool call(s)`
    + (titles.length ? `, tools: [${titles.join(" / ")}]` : ", no tool calls")
    + (statuses.length ? `, status: ${statuses.join("/")}` : "")
    + (acp.media.length ? `, ${acp.media.length} media path(s) extracted` : "");
}

async function testVideo() {
  const cwd = mkTmp("vid");
  const acp = new Acp(cwd);
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    let pr;
    try {
      pr = await withTimeout(
        acp.send("session/prompt", { sessionId: ns.result.sessionId, prompt: [{ type: "text", text: "/imagine-video a red cube slowly rotating on a white background" }] }),
        VIDEO_TIMEOUT_MS, "/imagine-video");
    } catch (e) {
      // xAI video gen is slow + variable; a headless gate run can exceed the wait
      // window even though /imagine-video works interactively. A timeout is
      // inconclusive, not a regression — SKIP (don't fail the gate), and report
      // what grok was last doing so a real hang (no tool calls) still stands out.
      if (/^timeout after/.test(e.message)) throw new Skip(`/imagine-video didn't finish within ${VIDEO_TIMEOUT_MS}ms — ${videoProgress(acp)}`);
      throw e;
    }
    if (pr.error) throw new Skip("/imagine-video errored (likely no subscription): " + JSON.stringify(pr.error));
    const vids = acp.media.filter((m) => m.media === "video");
    if (vids.length === 0) {
      if (/subscription|unauthor|forbidden|upgrade/i.test(acp.lastStderr || acp.agentText())) throw new Skip("video generation unavailable (subscription/auth)");
      throw new Skip("grok produced no video (model declined or feature gated) — agent said: " + acp.agentText().slice(0, 120));
    }
    const ref = vids[0];
    assert(fs.existsSync(ref.path), "extractor returned a video path that doesn't exist on disk: " + ref.path);
    const bytes = fs.statSync(ref.path).size;
    assert(bytes > 10000, "generated video file is suspiciously small: " + bytes + " bytes");
    return `video at ${path.basename(ref.path)} (${(bytes / 1024).toFixed(0)} KB), classified media:"video"`;
  } finally { acp.kill(); }
}

async function testSubagent() {
  const cwd = mkTmp("sub");
  // seed a couple of files so a "investigate the codebase" task is delegation-worthy
  fs.writeFileSync(path.join(cwd, "app.js"), "const {add}=require('./math');\nconsole.log(add(2,3));\n");
  fs.writeFileSync(path.join(cwd, "math.js"), "function add(a,b){return a+b}\nmodule.exports={add};\n");
  const acp = new Acp(cwd, { extraArgs: ["--always-approve"] });
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    await withTimeout(
      acp.send("session/prompt", { sessionId: ns.result.sessionId, prompt: [{ type: "text", text: "Use a subagent to read math.js and report in one sentence what add() does. Delegate to a subagent." }] }),
      300000, "subagent prompt");

    // Regression guard: grok's get_command_or_subagent_output is an output READER,
    // not a delegation. Its tool name contains "subagent", which used to false-fire
    // a Subagent card. The classifier must never match it — assert on every real
    // poller call grok made this run.
    const misfired = acp.taskOutputCalls.filter((u) => isSubagentToolCall(u));
    assert(misfired.length === 0, `isSubagentToolCall wrongly matched ${misfired.length} get_command_or_subagent_output poller(s)`);

    // Did grok actually delegate? On the native build that's a background task +
    // task-output poll; some builds may instead emit a genuine spawn_subagent.
    const bgIds = new Set(acp.bgTasks.map((u) => u.toolCallId));
    const pollIds = new Set(acp.taskOutputCalls.map((u) => u.toolCallId));
    if (bgIds.size === 0 && pollIds.size === 0 && acp.subagentCalls.length === 0) {
      throw new Skip("grok did not delegate this run (non-deterministic) — saw " +
        acp.updates.filter((u) => u.sessionUpdate === "tool_call").length +
        " tool calls, none a subagent / background task");
    }
    if (acp.subagentCalls.length > 0) {
      const labels = [...new Set(acp.subagentCalls.map(subagentLabel))];
      // Hard gate: a genuine spawn_subagent delegation must surface its lifecycle
      // on the LIVE rail — the extension fills the card's duration/output from it
      // (v1.6.1). A brief wait covers transport-tail timing after the turn ends.
      await waitFor(() => acp.xaiNotifs.some((u) => u.sessionUpdate === "subagent_finished"),
        15000, "live subagent_finished after a genuine spawn_subagent delegation");
      const spawned = acp.xaiNotifs.filter((u) => u.sessionUpdate === "subagent_spawned");
      const finished = acp.xaiNotifs.filter((u) => u.sessionUpdate === "subagent_finished");
      assert(spawned.length > 0, "spawn_subagent delegated but NO live subagent_spawned arrived (wire drift)");
      const matched = finished.find((f) => spawned.some((s) => s.subagent_id === f.subagent_id));
      assert(matched, "no subagent_finished matched a subagent_spawned by subagent_id");
      assert(typeof matched.duration_ms === "number" && matched.duration_ms >= 0,
        "subagent_finished.duration_ms not a finite non-negative number: " + JSON.stringify(matched.duration_ms));
      return `genuine spawn_subagent card(s): ${labels.join(", ")}; poller not carded; ` +
        `live lifecycle spawned=${spawned.length} finished=${finished.length} duration_ms=${matched.duration_ms}`;
    }
    return `delegated via background task (${bgIds.size} bg spawn, ${pollIds.size} output-poll); ` +
      `poller correctly NOT carded — grok's real subagent = background shell, see research/subagents.md`;
  } finally { acp.kill(); }
}

// Use the shared real ACP peer here: real terminal handlers, retained wire and
// normalized evidence, bounded process-tree cleanup, and no provider-home move.
async function testWorkflow() {
  const { Peer, selectSmokeModel, checkWorkflow, delegationAttempted, WORKFLOW_PROMPT, timeoutMs } = await import("./acp-smoke.mjs");
  const { grokBackend } = require(path.join(REPO, "out", "grok-backend.js"));
  const { TerminalManager } = require(path.join(REPO, "out", "terminal-manager.js"));
  const { parseRunProgressUpdate } = require(path.join(REPO, "out", "run-progress.js"));
  const rpcMs = timeoutMs(process.env.ACP_SMOKE_RPC_TIMEOUT_MS, 90000);
  const turnMs = timeoutMs(process.env.ACP_SMOKE_TURN_TIMEOUT_MS, 180000);
  const workflowMs = timeoutMs(process.env.ACP_SMOKE_WORKFLOW_TIMEOUT_MS, 300000);
  const parent = path.join(REPO, ".verification", "acp-smoke");
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, "grok-workflow-"));
  console.log(`grok workflow evidence: ${output}`);
  let cwd;
  let peer;
  const report = { provider: "grok", capability: "workflow", result: "FAIL", detail: "not exercised" };
  try {
    cwd = fs.realpathSync(mkTmp("workflow"));
    const fromRepo = path.relative(REPO, cwd);
    assert(path.isAbsolute(fromRepo) || fromRepo === ".." || fromRepo.startsWith(`..${path.sep}`), "OS-temp workflow scratch must be outside the repository");
    assert(!/fake-|[\\/]fixtures[\\/]/i.test(GROK), "refusing fixture Grok CLI");
    peer = new Peer(grokBackend.spawn({ cliPath: GROK, cwd, env: { ...process.env } }), cwd,
      path.join(output, "grok.jsonl"), rpcMs, turnMs, TerminalManager, grokBackend, grokBackend, parseRunProgressUpdate);
    const init = await peer.request("initialize", INIT);
    assert(init.protocolVersion === 1, "initialize.protocolVersion must be 1");
    const session = await peer.request("session/new", { cwd, mcpServers: [] });
    assert(session.sessionId, "session/new returned no sessionId");
    const selected = selectSmokeModel(grokBackend.normalizeSessionResponse(session), process.env.ACP_SMOKE_GROK_MODEL);
    const call = grokBackend.setModel(session.sessionId, selected.modelId, selected.effort);
    const response = await peer.request(call.method, call.params);
    assert(grokBackend.modelSetSucceeded(response), "workflow model selection rejected: " + JSON.stringify(response));
    report.model = selected;
    console.log(`grok workflow model=${selected.modelId}; effort=${selected.effort || "N/A (not advertised)"}; ${selected.basis}`);
    const from = peer.normalized.length;
    const turn = peer.prompt(session.sessionId, WORKFLOW_PROMPT);
    const result = await turn.promise;
    assert(result.stopReason === "end_turn", "workflow prompt failed: " + JSON.stringify(result));
    const frames = () => peer.normalized.slice(from).filter(f => f.sessionId === session.sessionId);
    if (delegationAttempted(frames(), "workflow") || frames().some(f => f.workflow)) {
      await peer.waitUntil(() => frames().some(f => f.workflow?.done), "Grok parsed workflow terminal update", workflowMs);
    }
    report.detail = checkWorkflow(frames(), "grok");
    await peer.stop();
    peer = undefined;
    report.result = "PASS";
    return report.detail;
  } catch (error) {
    report.detail = error.message;
    if (error instanceof Skip) throw error;
    if (error.code === "MODEL_DID_NOT_DELEGATE") {
      report.result = "INCONCLUSIVE";
      throw new Skip(error.message + `; evidence: ${output}`);
    }
    throw error;
  } finally {
    try { if (peer) await peer.stop(); }
    catch (error) { report.result = "FAIL"; report.detail = `cleanup failed: ${error.message}`; throw error; }
    finally {
      try {
        if (cwd) {
          const relative = path.relative(fs.realpathSync(os.tmpdir()), cwd);
          assert(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
            && path.basename(cwd).startsWith("grok-live-workflow-"), "refusing cleanup outside workflow OS-temp scratch");
          fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      } catch (error) { report.result = "FAIL"; report.detail = `scratch cleanup failed: ${error.message}`; throw error; }
      finally {
        fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        const wire = path.join(output, "grok.jsonl");
        if (fs.existsSync(wire)) fs.appendFileSync(path.join(liveEvidence(), "grok-wire.jsonl"), fs.readFileSync(wire));
      }
    }
  }
}

async function testRender() {
  const { runRenderSmoke } = await import("./smoke-render.mjs");
  const rendered = await runRenderSmoke("grok", liveEvidence(), GROK);
  if (rendered.scenarios.some(s => s.result === "INCONCLUSIVE")) throw new Skip("render scenarios unproven; read grok-render/render-report.md");
  return "real desktop host and chat.js rendered plain reply, subagent and workflow; content remains for the judge";
}

// Composer-agent variant: the Composer wire differs from grok-build's in every
// subagent-relevant way — the delegation tool is named "Task" (not
// spawn_subagent), its completion is an UNTITLED tool_call_update with
// rawOutput {type:"Text"} and NO duration, and the duration/output ride the
// subagent_spawned/subagent_finished lifecycle events instead (wire capture:
// test/fixtures/composer-subagent-session.jsonl). Pin both shapes so agent-side
// drift fails the gate, not the user's chat. Selects the first *composer* model
// right after session/new — the agent is rebindable until the first turn.
async function testSubagentComposer() {
  const cwd = mkTmp("subc");
  fs.writeFileSync(path.join(cwd, "app.js"), "const {add}=require('./math');\nconsole.log(add(2,3));\n");
  fs.writeFileSync(path.join(cwd, "math.js"), "function add(a,b){return a+b}\nmodule.exports={add};\n");
  const acp = new Acp(cwd, { extraArgs: ["--always-approve"] });
  try {
    await withTimeout(acp.send("initialize", INIT), 30000, "init");
    const ns = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "new");
    assert(ns.result && ns.result.sessionId, "session/new failed");
    const models = (ns.result.models && ns.result.models.availableModels) || [];
    const composer = models.find((m) => /composer/i.test(String(m.modelId || "")));
    if (!composer) throw new Skip("no Composer model available on this account/build");
    const sm = await withTimeout(
      acp.send("session/set_model", { sessionId: ns.result.sessionId, modelId: composer.modelId }),
      30000, "set_model");
    if (sm.error) throw new Skip(`set_model(${composer.modelId}) rejected: ${JSON.stringify(sm.error).slice(0, 120)}`);
    await withTimeout(
      acp.send("session/prompt", { sessionId: ns.result.sessionId, prompt: [{ type: "text", text: "Use a subagent to read math.js and report in one sentence what add() does. Delegate to a subagent." }] }),
      300000, "composer subagent prompt");

    const misfired = acp.taskOutputCalls.filter((u) => isSubagentToolCall(u));
    assert(misfired.length === 0, `isSubagentToolCall wrongly matched ${misfired.length} poller(s)`);
    if (acp.subagentCalls.length === 0 && acp.bgTasks.length === 0) {
      throw new Skip("composer did not delegate this run (non-deterministic)");
    }
    // Composer's completion is an UNTITLED tool_call_update (status completed,
    // no _meta) on the SAME toolCallId as the Task call — the shape the card
    // relies on. Its absence after a real delegation is wire drift.
    const subIds = new Set(acp.subagentCalls.map((u) => u.toolCallId));
    const completed = acp.updates.filter((u) =>
      u.sessionUpdate === "tool_call_update" &&
      subIds.has(u.toolCallId) &&
      String(u.status || "").toLowerCase() === "completed");
    assert(completed.length > 0, "Task delegation never completed on the tool channel — the card would spin forever (wire drift)");
    // Composer's tool-channel completion carries NO duration — the extension
    // fills it from subagent_finished on the LIVE rail (v1.6.1). Since a Task
    // delegation demonstrably ran (tool completion above), hard-gate the live
    // lifecycle: without it, Composer cards lose their duration/output entirely.
    await waitFor(() => acp.xaiNotifs.some((u) => u.sessionUpdate === "subagent_finished"),
      15000, "live subagent_finished after a Composer Task delegation");
    const liveSpawned = acp.xaiNotifs.filter((u) => u.sessionUpdate === "subagent_spawned");
    const liveFinished = acp.xaiNotifs.filter((u) => u.sessionUpdate === "subagent_finished");
    assert(liveSpawned.length > 0, "Composer delegated but NO live subagent_spawned arrived (wire drift)");
    const matched = liveFinished.find((f) => liveSpawned.some((s) => s.subagent_id === f.subagent_id));
    assert(matched, "no Composer subagent_finished matched a subagent_spawned by subagent_id");
    assert(typeof matched.duration_ms === "number" && matched.duration_ms >= 0,
      "Composer subagent_finished.duration_ms not finite/non-negative: " + JSON.stringify(matched.duration_ms));
    const labels = [...new Set(acp.subagentCalls.map(subagentLabel))];
    return `composer(${composer.modelId}) delegated: ${labels.join(", ") || "(bg)"}; ` +
      `${completed.length} tool-channel completion(s); live lifecycle spawned=${liveSpawned.length} finished=${liveFinished.length} duration_ms=${matched.duration_ms}`;
  } finally { acp.kill(); }
}

// The context donut's post-/compact refresh (v1.6.1) rides the LIVE
// _x.ai/session_notification rail: auto_compact_completed.tokens_after. This is
// the drift canary — if a CLI stops emitting it, the donut silently falls back
// to the slower /session-info scrape (and, on a build lacking that too, wouldn't
// refresh at all). Feed the real payload through the SAME
// contextUsedFromCompactNotification the host uses. A native /compact emits
// auto_compact_completed (never _started), so this also pins the method name.
async function testCompactNotification() {
  const cwd = mkTmp("compact");
  const acp = new Acp(cwd);
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;
    // A little history so /compact has something to compress.
    const s1 = await withTimeout(acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "In one short sentence, say hello." }] }), 120000, "seed1");
    assert(!s1.error, "seed1 prompt errored: " + JSON.stringify(s1.error));
    const s2 = await withTimeout(acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Name one primary color. One word only." }] }), 120000, "seed2");
    assert(!s2.error, "seed2 prompt errored: " + JSON.stringify(s2.error));
    const before = acp.xaiNotifs.length;
    const cr = await withTimeout(acp.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] }), 120000, "/compact");
    assert(!cr.error, "/compact errored: " + JSON.stringify(cr.error));
    const fresh = acp.xaiNotifs.slice(before);
    const completed = fresh.find((u) => u.sessionUpdate === "auto_compact_completed");
    assert(completed, "no auto_compact_completed on _x.ai/session_notification after /compact — the v1.6.1 donut refresh would silently regress");
    const used = contextUsedFromCompactNotification(completed);
    assert(typeof used === "number" && used > 0,
      "auto_compact_completed.tokens_after is not a positive number: " + JSON.stringify(completed));
    // A MANUAL /compact must NOT emit auto_compact_started — that's the auto-only
    // signal the "Auto-compacting…" note keys on. Live-pin the distinction.
    const started = fresh.find((u) => u.sessionUpdate === "auto_compact_started");
    assert(!started, "manual /compact unexpectedly emitted auto_compact_started — the auto-compact note would misfire on manual compaction");
    return `auto_compact_completed.tokens_after=${used}, no auto_compact_started (auto/manual distinction confirmed)`;
  } finally { acp.kill(); }
}

// Live reasoning-effort switch (v1.6.1): the model advertises
// supportsReasoningEffort and set_model accepts an _meta.reasoningEffort override
// with no process restart. This is a REAL application gate, not just acceptance:
// after set_model we hard-wait for a `model_changed` notification whose
// `reasoning_effort` equals the target — the EFFECTIVE effort the CLI applied
// (broadcast post-resolution, model_switch.rs). A build that accepts the request
// but ignores the override (the silent-no-op) fails here instead of lying green.
async function testEffortLive() {
  const cwd = mkTmp("effort");
  const acp = new Acp(cwd);
  try {
    let r = await withTimeout(acp.send("initialize", INIT), 30000, "init");
    assert(!r.error, "init errored");
    r = await withTimeout(acp.send("session/new", { cwd, mcpServers: [] }), 30000, "session/new");
    assert(r.result && r.result.sessionId, "session/new failed: " + JSON.stringify(r.error));
    const sessionId = r.result.sessionId;
    const models = (r.result.models && r.result.models.availableModels) || [];
    const currentId = r.result.models && r.result.models.currentModelId;
    // Resolve the current model via the REAL resolver (grok can echo a versioned
    // id not in the list); do NOT blindly fall back to models[0].
    const resolvedId = resolveModelId(currentId, models);
    const cur = models.find((m) => m.modelId === resolvedId) || models.find((m) => m.modelId === currentId);
    if (!cur || !(cur._meta && cur._meta.supportsReasoningEffort)) {
      throw new Skip("current model does not advertise supportsReasoningEffort — live effort N/A on this build/model");
    }
    const advertised = cur._meta.reasoningEffort;
    // Pick a target the model actually offers (from reasoningEfforts) that differs
    // from the advertised one — hardcoding low/high could pick an unoffered value.
    const offered = ((cur._meta.reasoningEfforts || []).map((e) => e && e.value).filter(Boolean));
    const target = offered.find((e) => e !== advertised) || (advertised === "low" ? "high" : "low");
    const before = acp.xaiNotifs.length;
    const sr = await withTimeout(
      acp.send("session/set_model", { sessionId, modelId: cur.modelId, _meta: { reasoningEffort: target } }),
      30000, "set_model effort");
    assert(!sr.error, "set_model with _meta.reasoningEffort errored: " + JSON.stringify(sr.error));
    assert(sr.result && sr.result._meta && sr.result._meta.model && sr.result._meta.model.Ok,
      "set_model did not return _meta.model.Ok: " + JSON.stringify(sr.result));
    // The authoritative ack: model_changed with the EFFECTIVE effort == target.
    await waitFor(
      () => acp.xaiNotifs.slice(before).some((u) => u.sessionUpdate === "model_changed" && u.reasoning_effort === target),
      10000, `model_changed with reasoning_effort=${target} (proves the override was APPLIED, not just accepted)`);
    return `advertised=${advertised}, offered=[${offered.join(",")}]; applied reasoningEffort→${target} live, confirmed via model_changed`;
  } finally { acp.kill(); }
}

// ── registry + runner ────────────────────────────────────────────────────────
const TESTS = [
  { name: "handshake", fn: testHandshake, slow: false, smoke: true },
  { name: "capabilities", fn: testCapabilities, slow: false, smoke: true },
  // #46 — local (non-grok) validation of the shipped TerminalManager's shell host.
  { name: "terminal-shell", fn: testTerminalShell, slow: false, smoke: true },
  { name: "prompt-roundtrip", fn: testPrompt, slow: false },
  { name: "cancel-mid-turn", fn: testCancelMidTurn, slow: false },
  { name: "interject", fn: testInterject, slow: false },
  { name: "session-fork", fn: testSessionFork, slow: false },
  { name: "worktree", fn: testWorktree, slow: false },
  { name: "rewind", fn: testRewind, slow: false },
  { name: "rewind-files", fn: testRewindFiles, slow: true },
  { name: "parallel-sessions", fn: testParallelSessions, slow: false },
  { name: "vision-prompt", fn: testVisionPrompt, slow: false },
  { name: "session-restore", fn: testRestore, slow: false },
  { name: "edit-diff-restore", fn: testEditDiffRestore, slow: false },
  // v1.6.1 notification-rail features (drift canaries):
  { name: "compact-notification", fn: testCompactNotification, slow: false },
  { name: "effort-live", fn: testEffortLive, slow: false, smoke: true },
  // The native reject-then-approve plan loop is intentionally slow, so it's
  // slow enough to skip under --quick; the full release gate still runs it.
  { name: "plan-mode", fn: testPlanMode, slow: true },
  // Rewind/Edit over repeated cancelled plans — the map + discard-semantics gate.
  { name: "plan-cancel-rewind", fn: testPlanCancelRewind, slow: true },
  // Per-turn billing must stay per-turn, or rewind can't subtract it (#53).
  { name: "usage-per-turn", fn: testUsagePerTurn, slow: false },
  { name: "image-gen", fn: testImage, slow: true },
  // video-gen is opt-in only (run with --only=video-gen). In this headless harness
  // grok 0.2.x spins on /imagine-video instead of producing a clip, so it never
  // completes and is excluded from the default release gate — the feature works
  // interactively. See the testVideo comment + the SKIP-on-timeout handling.
  { name: "video-gen", fn: testVideo, slow: true, optIn: true },
  { name: "subagent", fn: testSubagent, slow: true },
  { name: "workflow", fn: testWorkflow, slow: true },
  { name: "subagent-composer", fn: testSubagentComposer, slow: true },
  { name: "render", fn: testRender, slow: true },
];

function selected() {
  let list = TESTS;
  if (ONLY.length) list = list.filter((t) => ONLY.includes(t.name) || (t.name === "render" && ONLY.some(name => ["subagent", "subagent-composer", "workflow"].includes(name))));
  else if (SMOKE) list = list.filter((t) => t.smoke); // fast lane: handshake + capabilities
  else list = list.filter((t) => !t.optIn); // opt-in tests only run when named in --only
  if (SKIP.length) list = list.filter((t) => !SKIP.includes(t.name));
  if (QUICK) list = list.filter((t) => !t.slow);
  return list;
}

(async () => {
  const list = selected();
  console.log(`\n grok live suite — binary: ${GROK}`);
  console.log(` grok --version: ${GROK_VERSION || "(unreadable)"}`);
  console.log(` initialize.clientCapabilities: ${JSON.stringify(INIT.clientCapabilities)}`);
  console.log(` running ${list.length} test(s)${QUICK ? " (quick: generative tests skipped)" : ""}\n`);
  const results = [];
  for (const t of list) {
    liveScenario = t.name;
    const started = process.hrtime.bigint();
    process.stdout.write(`  • ${t.name} … `);
    try {
      const detail = await t.fn();
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      console.log(`PASS (${ms}ms)\n      ${detail}`);
      results.push({ name: t.name, status: "PASS", detail });
    } catch (e) {
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      if (e instanceof Skip) {
        console.log(`SKIP (${ms}ms)\n      ${e.message}`);
        results.push({ name: t.name, status: "SKIP", detail: e.message });
      } else {
        console.log(`FAIL (${ms}ms)\n      ${e.message}`);
        results.push({ name: t.name, status: "FAIL", detail: e.message });
      }
    }
  }
  const { knownBoundaries, classifyBoundaries, renderReportMarkdown } = await import("./smoke-render-report.mjs");
  const output = liveEvidence();
  const wire = path.join(output, "grok-wire.jsonl");
  const events = fs.existsSync(wire) ? fs.readFileSync(wire, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  const known = knownBoundaries(REPO, "grok");
  const boundaries = classifyBoundaries(events, known);
  const desktopPath = path.join(output, "grok-render", "render-report.json");
  if (fs.existsSync(desktopPath)) {
    const desktop = JSON.parse(fs.readFileSync(desktopPath, "utf8"));
    for (const key of ["seen", "unhandled", "ignored"]) boundaries[key].push(...desktop.boundaries[key]);
  }
  const audit = { provider: "grok", route: "all selected live ACP checks plus desktop lane when selected", scenarios: [], known, boundaries, results };
  fs.writeFileSync(path.join(output, "boundaries.json"), JSON.stringify(audit, null, 2));
  fs.writeFileSync(path.join(output, "boundaries.md"), renderReportMarkdown(audit));
  console.log(renderReportMarkdown(audit));
  if (boundaries.unhandled.length) results.push({ name: "boundary audit", status: "FAIL", detail: "UNHANDLED kinds; inspect boundaries.json" });
  console.log(`Evidence: ${output}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n ── summary ──  ${pass} passed · ${skip} skipped · ${fail} failed`);
  for (const r of results) if (r.status !== "PASS") console.log(`   ${r.status}  ${r.name}`);
  console.log("");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("runner crashed:", e); process.exit(2); });
