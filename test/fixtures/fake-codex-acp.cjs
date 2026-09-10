#!/usr/bin/env node
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1000;
let cancelPromptId;
const sessionId = process.env.FAKE_SESSION_ID_FROM_PID === "1"
  ? `0198f0d1-2b3c-7d4e-8f50-${String(process.pid).padStart(12, "0").slice(-12)}`
  : (process.env.FAKE_CODEX_SESSION_ID || "0198f0d1-2b3c-7d4e-8f50-123456789abc");
const config = {
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  mode: "agent",
  collaboration_mode: "default",
};

function caseDriftedCwd(cwd) {
  const value = String(cwd || "");
  const driveAdjusted = value.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  const parts = driveAdjusted.split(/([\\/]+)/);
  for (let index = parts.length - 1; index >= 0; index -= 2) {
    if (!parts[index] || /^[A-Z]:$/.test(parts[index])) continue;
    parts[index] = parts[index].toUpperCase();
    break;
  }
  return parts.join("");
}

function appendSpawnProbe() {
  const sink = process.env.FAKE_CODEX_SPAWN_SINK;
  if (!sink) return;
  require("node:fs").appendFileSync(sink, JSON.stringify({
    type: "spawn",
    pid: process.pid,
    cwd: process.cwd(),
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
    codexPath: process.env.CODEX_PATH,
  }) + "\n");
}

function appendEvent(type, data = {}) {
  const sink = process.env.FAKE_CODEX_STEERING_SINK || process.env.FAKE_CODEX_SPAWN_SINK;
  if (!sink) return;
  require("node:fs").appendFileSync(sink, JSON.stringify({ type, pid: process.pid, cwd: process.cwd(), at: Date.now(), ...data }) + "\n");
}

function persistedSessions() {
  const sink = process.env.FAKE_CODEX_SPAWN_SINK;
  if (!sink) return [];
  try {
    const events = require("node:fs").readFileSync(sink, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const deleted = new Set(events
      .filter((event) => event.type === "session/delete")
      .map((event) => event.sessionId));
    const byId = new Map();
    for (const event of events) {
      if (event.type !== "session/new" || !event.sessionId || deleted.has(event.sessionId)) continue;
      byId.set(event.sessionId, {
        sessionId: event.sessionId,
        cwd: caseDriftedCwd(event.cwd),
        title: "GPT",
        updatedAt: event.at,
      });
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

function deletedSessionIds() {
  const sink = process.env.FAKE_CODEX_SPAWN_SINK;
  if (!sink) return new Set();
  try {
    return new Set(require("node:fs").readFileSync(sink, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "session/delete")
      .map((event) => event.sessionId));
  } catch {
    return new Set();
  }
}

function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function ok(id, result = {}) { send({ jsonrpc: "2.0", id, result }); }
function notify(update, meta) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update, ...(meta ? { _meta: meta } : {}) } });
}
function call(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function configOptions() {
  return Object.entries(config).map(([id, currentValue]) => ({ id, currentValue }));
}
function models() {
  return {
    currentModelId: `${config.model}[${config.reasoning_effort}]`,
    availableModels: [
      { modelId: "gpt-5.6-sol[low]", name: "GPT 5.6 Sol low" },
      { modelId: "gpt-5.6-sol[high]", name: "GPT 5.6 Sol high" },
      { modelId: "gpt-5.6-sol[ultra]", name: "GPT 5.6 Sol ultra" },
      { modelId: "gpt-5.6-terra[medium]", name: "GPT 5.6 Terra medium" },
      { modelId: "gpt-5.6-terra[max]", name: "GPT 5.6 Terra max" },
    ],
  };
}

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && msg.method == null && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  const { id, method, params = {} } = msg;
  if (method === "initialize") {
    appendSpawnProbe();
    return ok(id, { protocolVersion: 1, serverInfo: { name: "fake-codex-acp", version: "1.1.14" }, _meta: {
      codexPath: process.env.CODEX_PATH,
      ...(process.env.FAKE_CODEX_STEERING === "absent" ? {} : { steering: { supported: process.env.FAKE_CODEX_STEERING !== "false" } }),
    } });
  }
  if (method === "session/new") {
    appendEvent("session/new", { sessionId });
    return ok(id, { sessionId, models: models(), configOptions: configOptions() });
  }
  if (method === "session/load") {
    appendEvent("session/load", { sessionId: params.sessionId });
    notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "restored question" } }, { isReplay: true });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restored answer" } }, { isReplay: true });
    return ok(id, { sessionId: params.sessionId, models: models(), configOptions: configOptions() });
  }
  if (method === "session/set_config_option") {
    config[params.configId] = params.value;
    process.stderr.write(`CONFIG:${JSON.stringify(params)}\n`);
    return ok(id, { configOptions: configOptions() });
  }
  if (method === "session/list") {
    if (Object.prototype.hasOwnProperty.call(params, "cwd")) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "cwd must be omitted" } });
    const deleted = deletedSessionIds();
    if (!params.cursor) return ok(id, {
      sessions: [
        ...persistedSessions(),
        { sessionId: "listed-1", cwd: caseDriftedCwd(process.cwd()), title: "First", updatedAt: 10 },
        { sessionId: "refuse-delete", cwd: caseDriftedCwd(process.cwd()), title: "Refused delete", updatedAt: 9.5 },
        { sessionId: "wrong", cwd: "C:\\GitHub\\Other", title: "Wrong", updatedAt: 9 },
      ].filter((entry) => !deleted.has(entry.sessionId)),
      nextCursor: "next",
    });
    return ok(id, {
      sessions: [{ sessionId: "listed-2", cwd: caseDriftedCwd(process.cwd()), title: "Second", updatedAt: 8 }]
        .filter((entry) => !deleted.has(entry.sessionId)),
      nextCursor: null,
    });
  }
  if (method === "session/delete") {
    process.stderr.write(`DELETE:${params.sessionId}\n`);
    if (params.sessionId === "refuse-delete") {
      return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "delete refused" } });
    }
    appendEvent("session/delete", { sessionId: params.sessionId });
    return ok(id, {});
  }
  if (method === "_x.ai/interject") {
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
  if (method === "_session/steering") {
    if (params.sessionId !== sessionId || !Array.isArray(params.prompt)) {
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Expected sessionId and prompt array" } });
    }
    appendEvent("_session/steering", params);
    return ok(id, {});
  }
  if (method === "session/cancel") {
    if (cancelPromptId != null) {
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "trailing" } });
      ok(cancelPromptId, { stopReason: "cancelled", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 } });
      cancelPromptId = undefined;
    }
    return;
  }
  if (method === "session/prompt") {
    const text = Array.isArray(params.prompt) ? params.prompt[0]?.text ?? "" : "";
    if (text.includes("SCENARIO_STEERING")) {
      appendEvent("session/prompt");
      notify({ sessionUpdate: "tool_call", toolCallId: "in-flight", kind: "execute", title: "work", status: "in_progress" });
      await call("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "in-flight", kind: "execute", title: "work" },
        options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }],
      });
      notify({ sessionUpdate: "tool_call_update", toolCallId: "in-flight", status: "completed" });
      return ok(id, { stopReason: "end_turn" });
    }
    if (text.includes("SCENARIO_CANCEL")) {
      cancelPromptId = id;
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } });
      return;
    }
    if (text.includes("SCENARIO_AUTH")) {
      return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required: not logged in" } });
    }
    if (text.includes("SCENARIO_IMAGE_GENERATION")) {
      return runImageGeneration(id);
    }
    return runPrompt(id);
  }
});

function runImageGeneration(id) {
  const toolCallId = process.env.FAKE_CODEX_IMAGE_TOOL_CALL_ID || "exec-550e8400-e29b-41d4-a716-446655440000";
  notify({
    sessionUpdate: "tool_call", toolCallId, kind: "other", title: "Image generation",
    rawInput: { id: toolCallId },
  });
  const codexHome = process.env.CODEX_HOME || require("node:path").join(require("node:os").homedir(), ".codex");
  if (process.env.FAKE_CODEX_SKIP_IMAGE_ARTIFACT !== "1") {
    const artifact = require("node:path").join(codexHome, "generated_images", sessionId, `${toolCallId}.png`);
    require("node:fs").mkdirSync(require("node:path").dirname(artifact), { recursive: true });
    // 1x1 transparent PNG. The captured adapter writes the artifact before the
    // completed update; preserve that ordering so the host can serve it at once.
    require("node:fs").writeFileSync(artifact, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  }
  notify({
    sessionUpdate: "tool_call_update", toolCallId, status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Revised prompt: a precise generated image" } }],
  });
  ok(id, { stopReason: "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 } });
}

async function runPrompt(id) {
  notify({ sessionUpdate: "session_info_update", status: "active", waitingOnApproval: false, title: "Generated Codex title", unknownFutureField: true });
  notify({ sessionUpdate: "usage_update", used: 4321, size: 258400 });
  notify({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review changes", _meta: { commandAction: "review" } }] });
  notify({
    sessionUpdate: "tool_call", toolCallId: "cmd-1", kind: "execute", title: "node -e echo",
    rawInput: { command: "node -e \"console.log('ok')\"", cwd: "C:\\GitHub\\Repo" },
    content: [{ type: "terminal", terminalId: "server-side" }],
  });
  notify({
    sessionUpdate: "tool_call_update", toolCallId: "cmd-1", status: "completed",
    rawOutput: { formatted_output: "ok\n", exit_code: 0 },
    _meta: { terminal_output_delta: { data: "ok\n" }, terminal_exit: { exit_code: 0 } },
  });
  notify({
    sessionUpdate: "tool_call", toolCallId: "edit-1", kind: "edit", title: "Editing files",
    content: [{ type: "diff", oldText: null, newText: "export const made = true;\n", path: "src/made.ts", _meta: { kind: "create" } }],
  });
  notify({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" });
  notify({
    sessionUpdate: "tool_call", toolCallId: "mcp-1", kind: "execute", title: "mcp.canva.search-designs",
    rawInput: { server: "canva", tool: "search-designs", arguments: { query: "logo" } },
    _meta: { is_mcp_tool_call: true },
  });
  notify({
    sessionUpdate: "tool_call_update", toolCallId: "mcp-1", status: "completed",
    rawInput: { server: "canva", tool: "search-designs", arguments: { query: "logo" } },
    rawOutput: { result: { content: [{ type: "text", text: "ok" }] }, error: null },
  });
  const approval = await call("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "cmd-2", kind: "execute", rawInput: { command: "npm test\nignored" } },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
      { optionId: "accept_execpolicy_amendment", kind: "allow_always", name: "Amend policy" },
      { optionId: "reject_once", kind: "reject_once", name: "Reject" },
    ],
    _meta: { codex: { kind: "approval" } },
  });
  process.stderr.write(`PERMISSION:${JSON.stringify(approval)}\n`);
  const review = await call("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "plan-1", kind: "switch_mode", title: "Implement this plan?", rawInput: { plan: "# Plan\n\n1. Change it" } },
    options: [
      { optionId: "implement_plan", kind: "allow_once", name: "Implement" },
      { optionId: "revise_plan", kind: "reject_once", name: "Revise" },
    ],
    _meta: { codex: { kind: "plan_review" } },
  });
  process.stderr.write(`PLAN_REVIEW:${JSON.stringify(review)}\n`);
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "codex ok" } });
  ok(id, {
    stopReason: "end_turn",
    usage: { totalTokens: 100, inputTokens: 60, cachedReadTokens: 20, outputTokens: 30, thoughtTokens: 10 },
    _meta: { quota: { token_count: 100, model_usage: [{ model: config.model, inputTokens: 60 }] } },
  });
}

rl.on("close", () => process.exit(0));
