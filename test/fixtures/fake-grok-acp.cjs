#!/usr/bin/env node
// Minimal fake `grok agent stdio` for integration tests. Speaks the subset of
// ACP that src/acp.ts actually exercises:
//   - initialize, session/new, session/load, session/set_model, session/set_mode,
//     session/prompt, session/cancel  (client → server)
//   - session/load reads GROK_HOME/sessions/<encoded-cwd>/<id>/{updates,chat_history}.jsonl
//     and streams those as session/update replay before the RPC result
//   - session/new mints a unique id when FAKE_UNIQUE_SESSION_IDS=1 (or
//     FAKE_SESSION_ID_FROM_PID=1); session/load updates the active id so
//     later notifications refer to the session that was actually loaded
//   - fs/write_text_file, terminal/create, x.ai/exit_plan_mode,
//     x.ai/ask_user_question  (server → client)
//   - session/update notifications (agent_message_chunk, and a user_message_chunk
//     echo of the live prompt — grok ≥0.2.33 does this on every prompt)
//
// Each test drives a scenario by sending a prompt whose text matches one of the
// SCENARIO_* tags below. The scenario script issues exactly the server→client
// requests we need to exercise the host's behavior (plan-snoop, gate blocking,
// exit_plan_mode round-trip), then ends the turn.
//
// Deliberately small and grok-version-independent: it encodes only what the
// protocol REQUIRES, not grok's quirks. The buggy "any response is approval"
// behavior is handled host-side; this fake just ends its turn whichever way
// the host replies to exit_plan_mode.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Accept the startup arg shapes the extension actually sends: `agent stdio`,
// optionally with `--reasoning-effort <value>` (an agent-level flag, before the
// stdio subcommand). Mirror grok's validation: only the real effort values are
// allowed; anything else (incl. the bogus `max`) exits 2 like the CLI does.
const VALID_EFFORT = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const argv = process.argv.slice(2);
// Desktop host + sidebar call `grok --version` before agent stdio. Answer with a
// supported banner so Plan availability is not falsely disabled in e2e runs.
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("grok 0.2.117 (fake-acp) [stable]\n");
  process.exit(0);
}
function argvOk(a) {
  if (a.length === 2) return a[0] === "agent" && a[1] === "stdio";
  if (a.length === 4) return a[0] === "agent" && a[1] === "--reasoning-effort" && VALID_EFFORT.has(a[2]) && a[3] === "stdio";
  return false;
}
if (!argvOk(argv)) {
  process.stderr.write(`unexpected argv: ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });

let nextId = 1000;
const pendingReplies = new Map(); // id we sent → resolver

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function respondOk(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function callClient(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      resolve({ error: { code: -32099, message: `Timed out waiting for ${method}` } });
    }, 2000);
    pendingReplies.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

const { createFakeSessionState } = require("./fake-session-state.cjs");
const sessions = createFakeSessionState({ env: process.env });
const PLAN_PATH = process.env.FAKE_PLAN_PATH || "/tmp/fake-grok-home/.grok/sessions/cwd-x/sess-y/plan.md";
const WORKSPACE_FILE = (process.env.FAKE_WORKSPACE_ROOT || "/tmp/fake-workspace") + "/file.ts";
const RELATIVE_WORKSPACE_FILE = "relative-file.ts";

function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".grok");
}

function storedSessionDir(cwd, sessionId) {
  if (!cwd || !sessionId) return "";
  return path.join(grokHome(), "sessions", encodeURIComponent(cwd), sessionId);
}

let activeContextWindow = 256000;
let activeContextUsed = Number(process.env.FAKE_CONTEXT_USED) || 16017;
let contextStatePath;

function openContextState(sessionId, cwd, resume) {
  if (!process.env.FAKE_CONTEXT_WINDOWS) return;
  contextStatePath = path.join(storedSessionDir(cwd, sessionId), "context-window.json");
  activeContextWindow = 256000;
  activeContextUsed = Number(process.env.FAKE_CONTEXT_USED) || 16017;
  if (resume && fs.existsSync(contextStatePath)) {
    const saved = JSON.parse(fs.readFileSync(contextStatePath, "utf8"));
    activeContextWindow = saved.window;
    activeContextUsed = saved.used;
  }
}

function sessionHandle(sessionId) {
  return {
    sessionId,
    models: {
      currentModelId: "fake-model",
      // Advertise per-session reasoning effort so the client's live-effort
      // gate (currentModelSupportsEffort) can be exercised; reasoningEffort is
      // the ACTIVE session override the client seeds currentReasoningEffort from.
      availableModels: [{
        modelId: "fake-model",
        name: "Fake",
        _meta: {
          ...(process.env.FAKE_CONTEXT_WINDOWS ? { contextWindows: [256000, 500000], totalContextTokens: activeContextWindow } : {}),
          supportsReasoningEffort: true,
          reasoningEffort: process.env.FAKE_CONFIG_EFFORT || "high",
          reasoningEfforts: [{ value: "high" }, { value: "medium" }, { value: "low" }],
        },
      }],
    },
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Agent" }, { id: "plan", name: "Plan" }] },
  };
}

function persistNewSession(sessionId, cwd) {
  const dir = storedSessionDir(cwd, sessionId);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const summary = path.join(dir, "summary.json");
    if (!fs.existsSync(summary)) {
      fs.writeFileSync(summary, JSON.stringify({ session_id: sessionId }));
    }
  } catch {
    /* catalog write is best-effort — the host already owns GROK_HOME */
  }
}

function replayStoredSession(sessionId, cwd) {
  const dir = storedSessionDir(cwd, sessionId);
  if (!dir) return;
  let st;
  try { st = fs.statSync(dir); } catch { return; }
  if (!st.isDirectory()) return;

  const updatesPath = path.join(dir, "updates.jsonl");
  if (fs.existsSync(updatesPath)) {
    replayUpdatesJsonl(sessionId, fs.readFileSync(updatesPath, "utf8"));
    return;
  }
  const historyPath = path.join(dir, "chat_history.jsonl");
  if (fs.existsSync(historyPath)) {
    replayChatHistory(sessionId, fs.readFileSync(historyPath, "utf8"));
  }
}

function replayUpdatesJsonl(sessionId, text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const update = rec?.update && rec.update.sessionUpdate ? rec.update
      : rec?.sessionUpdate ? rec
      : null;
    if (!update) continue;
    notify("session/update", { sessionId, update });
  }
}

function replayChatHistory(sessionId, text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const role = rec?.type ?? rec?.role;
    const raw = rec?.content;
    const content = typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : "";
    if (role === "user") {
      if (rec?.synthetic_reason) continue;
      const m = content.match(/<user_query>([\s\S]*?)(?:<\/user_query>|$)/);
      const body = (m ? m[1] : content).trim();
      if (!body || /^<user_info>/.test(body) || /^<system-reminder>/.test(body)) continue;
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: body } },
      });
    } else if (role === "assistant" || role === "agent") {
      const body = content.trim();
      if (!body) continue;
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } },
      });
    }
  }
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Responses to our outbound requests — pass to the awaiting promise.
  if (msg.id != null && !msg.method && pendingReplies.has(msg.id)) {
    pendingReplies.get(msg.id)({ result: msg.result, error: msg.error });
    pendingReplies.delete(msg.id);
    return;
  }

  // Inbound requests from the host.
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      process.stderr.write(`INITIALIZE_CAPS: ${JSON.stringify(params && params.clientCapabilities)}\n`);
      return respondOk(id, { protocolVersion: 1, serverCapabilities: {} });
    case "session/new": {
      const sid = sessions.onNew();
      persistNewSession(sid, params?.cwd);
      // FAKE_NEW_SESSION_DELAY_MS makes the agent slow ON PURPOSE.
      //
      // #133/#131 report the window freezing on open, and the host's own timing
      // line cannot tell two very different causes apart: an ASYNCHRONOUS wait
      // on this response, which leaves the message loop free and merely spins,
      // and SYNCHRONOUS work on the Electron main thread, which is what a white
      // title bar actually is. Both print as one number.
      //
      // Stalling only this reply separates them. Pair it with the main-process
      // heartbeat in scripts/open-timing-check.mjs: if the delay lands in `new`
      // and the heartbeat stays smooth, the wait is not the freeze.
      openContextState(sid, params.cwd, false);
      const delayMs = Number(process.env.FAKE_NEW_SESSION_DELAY_MS || 0);
      if (delayMs > 0) {
        setTimeout(() => respondOk(id, sessionHandle(sid)), delayMs);
        return;
      }
      return respondOk(id, sessionHandle(sid));
    }
    case "session/load": {
      // Resume must honor the requested id and replay whatever the host
      // already wrote under GROK_HOME (the integration fixture's
      // writeStoredSession / updates.jsonl, else chat_history.jsonl). Missing
      // files are an empty conversation, not an error — same as a brand-new
      // on-disk session. Later notifications use this same id — a pid-derived
      // constant would be a different conversation after a host restart.
      const sid = sessions.onLoad(params?.sessionId);
      openContextState(sid, params.cwd, true);
      replayStoredSession(sid, params?.cwd);
      return respondOk(id, sessionHandle(sid));
    }
    case "session/set_model": {
      if (process.env.FAKE_CONTEXT_WINDOWS && params._meta?.contextWindow) {
        const size = params._meta.contextWindow;
        if (process.env.FAKE_CONTEXT_ERROR || ![256000, 500000].includes(size)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "context window rejected" } });
        if (!process.env.FAKE_CONTEXT_UNCONFIRMED) activeContextWindow = size;
        if (!process.env.FAKE_CONTEXT_UNCONFIRMED && size < activeContextUsed) {
          notify("_x.ai/session_notification", { sessionId: sessions.id, update: { sessionUpdate: "auto_compact_started" } });
          activeContextUsed = 10000;
          notify("_x.ai/session_notification", { sessionId: sessions.id, update: { sessionUpdate: "auto_compact_completed", tokens_after: activeContextUsed } });
        }
        fs.mkdirSync(path.dirname(contextStatePath), { recursive: true });
        fs.writeFileSync(contextStatePath, JSON.stringify({ window: activeContextWindow, used: activeContextUsed }));
      }
      // Echo the received _meta so a test can assert the client sent
      // reasoningEffort on a live effort switch.
      process.stderr.write(`SET_MODEL: ${JSON.stringify({ modelId: params.modelId, _meta: params._meta })}\n`);
      // Mirror real grok: broadcast model_changed with the EFFECTIVE effort
      // BEFORE the response — the authoritative signal the client's effort state
      // syncs from (acp.ts session_notification handler).
      const eff = params._meta && params._meta.reasoningEffort;
      if (eff) {
        notify("_x.ai/session_notification", {
          sessionId: sessions.id,
          update: { sessionUpdate: "model_changed", model_id: params.modelId, reasoning_effort: eff },
        });
      }
      return respondOk(id, { _meta: { model: { Ok: params.modelId } } });
    }
    case "session/set_mode":
      return respondOk(id, {});
    case "_x.ai/session/info":
      return respondOk(id, {
        sessionId: sessions.id,
        context: {
          used: process.env.FAKE_CONTEXT_WINDOWS ? activeContextUsed : 16017,
          total: process.env.FAKE_CONTEXT_WINDOWS ? activeContextWindow : 512000,
          systemPromptTokens: 1039,
          toolDefinitionsTokens: 812,
          messageTokens: 12166,
          freeTokens: 495983,
          autoCompactThresholdPercent: 92,
          usageCategories: [{ label: "Skills", tokens: 1200 }],
        },
      });
    case "_x.ai/git/worktree/apply":
      return respondOk(id, { status: "ok", files: [], gitRoot: params?.worktreePath || "" });
    case "_x.ai/git/worktree/remove":
      return respondOk(id, { removed: true });
    case "_x.ai/git/worktree/create":
    case "_x.ai/git/worktree/list":
    case "_x.ai/git/worktree/status":
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    case "session/cancel":
      return respondOk(id, {});
    case "_x.ai/feedback":
      return respondOk(id, {});
    case "_x.ai/interject":
      if (String(params?.text || "").includes("SCENARIO_INTERJECT_ACK_THEN_EXIT")) {
        // Put the successful response on stdout and exit immediately after the
        // write reaches the pipe. The parent may observe process `exit` before
        // it drains that final line; its host-facing exit must wait for drain.
        return process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n",
          () => process.exit(0),
        );
      }
      if (Array.isArray(params?.content)) {
        const images = params.content.filter((b) => b && b.type === "image");
        process.stderr.write(
          `INTERJECT_CONTENT:${images.length}:${images.map((b) => b.mimeType).join(",")}\n`,
        );
      }
      return respondOk(id, {});
    case "session/prompt":
      return runScenario(id, extractPromptText(params), params);
  }
});

function extractPromptText(params) {
  if (Array.isArray(params?.prompt) && params.prompt[0]?.type === "text") {
    return params.prompt[0].text;
  }
  return "";
}

async function runScenario(promptId, text, params) {
  try {
    // grok ≥0.2.33 echoes the live prompt back as a user_message_chunk before it
    // starts working (0.2.3 did not). Model it on EVERY prompt so the host's
    // replay-only de-dup is faithfully exercised by the whole integration suite
    // — the regression that doubled every sent message lived exactly here.
    notify("session/update", { sessionId: sessions.id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });

    if (text.includes("SCENARIO_VISION_ECHO")) {
      // Echo what vision payload actually crossed the wire, so the test can
      // assert the client transmits image content blocks verbatim (count,
      // mime, non-empty base64) — the surface the real CLI consumes.
      const imgs = (params?.prompt ?? []).filter((b) => b && b.type === "image");
      const ok = imgs.every((b) => typeof b.data === "string" && b.data.length > 0);
      const summary = `vision:${imgs.length}:${imgs.map((b) => b.mimeType).join(",")}:${ok}`;
      notify("session/update", { sessionId: sessions.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary } } });
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 5 } });
      return;
    }

    if (text.includes("SCENARIO_PROPOSE_PLAN")) {
      // 1. Write to grok's own plan.md (outside the workspace — should be allowed).
      const planText = "# TEST PLAN\n\nStep 1\nStep 2";
      const writeResp = await callClient("fs/write_text_file", { sessionId: sessions.id, path: PLAN_PATH, content: planText });
      // 2. Send exit_plan_mode with planContent: null (matches grok 0.2.3 behavior).
      const exitResp = await callClient("x.ai/exit_plan_mode", { sessionId: sessions.id, planContent: null });
      // 3. End the turn whichever way the host replied.
      notify("session/update", { sessionId: sessions.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(plan turn end)" } } });
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 100 } });
      // Stash the exit response on stderr so the test can inspect what the host sent back.
      process.stderr.write(`EXIT_RESPONSE: ${JSON.stringify(exitResp)}\n`);
      return;
    }

    if (text.includes("SCENARIO_WORKSPACE_WRITE")) {
      const writeResp = await callClient("fs/write_text_file", { sessionId: sessions.id, path: WORKSPACE_FILE, content: "// new file" });
      process.stderr.write(`WRITE_RESPONSE: ${JSON.stringify(writeResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_RELATIVE_WORKSPACE_WRITE")) {
      const writeResp = await callClient("fs/write_text_file", { sessionId: sessions.id, path: RELATIVE_WORKSPACE_FILE, content: "// relative file" });
      process.stderr.write(`WRITE_RESPONSE: ${JSON.stringify(writeResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_MUTATING_TERMINAL")) {
      const termResp = await callClient("terminal/create", { sessionId: sessions.id, command: "rm -rf /tmp/foo" });
      process.stderr.write(`TERMINAL_RESPONSE: ${JSON.stringify(termResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_MUTATING_READONLY_HEAD_TERMINAL")) {
      const termResp = await callClient("terminal/create", { sessionId: sessions.id, command: "sed -i s/a/b/ file.ts" });
      process.stderr.write(`TERMINAL_RESPONSE: ${JSON.stringify(termResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_READONLY_TERMINAL")) {
      const termResp = await callClient("terminal/create", { sessionId: sessions.id, command: "ls -la" });
      process.stderr.write(`TERMINAL_RESPONSE: ${JSON.stringify(termResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_ASK_QUESTION")) {
      const askResp = await callClient("x.ai/ask_user_question", {
        sessionId: sessions.id,
        questions: [{
          question: "Pick one?",
          options: [{ label: "Option A", description: "first" }, { label: "Option B" }],
          multiSelect: false,
        }],
      });
      process.stderr.write(`ASK_RESPONSE: ${JSON.stringify(askResp)}\n`);
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 50 } });
      return;
    }

    if (text.includes("SCENARIO_COMPACT_NOTIFY")) {
      // grok emits the fresh post-compact context size on the LIVE
      // `_x.ai/session_notification` rail (auto_compact_completed.tokens_after),
      // as a no-id notification. The compact turn's own meta still reports 0
      // (stripped host-side). Shape captured from grok 0.2.101
      // (research/oss-surfaces-probe.cjs).
      notify("_x.ai/session_notification", {
        sessionId: sessions.id,
        update: { sessionUpdate: "auto_compact_completed", tokens_before: 20000, tokens_after: 12345, summary_preview: null },
      });
      notify("session/update", { sessionId: sessions.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(compacted)" } } });
      respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 0 } });
      return;
    }

    // Default: just emit one chunk and end.
    notify("session/update", { sessionId: sessions.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
    respondOk(promptId, { stopReason: "end_turn", _meta: { totalTokens: 10 } });
  } catch (e) {
    process.stderr.write(`SCENARIO_ERROR: ${e.message}\n`);
    respondOk(promptId, { stopReason: "error", _meta: { totalTokens: 0 } });
  }
}
