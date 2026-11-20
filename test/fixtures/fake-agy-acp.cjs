#!/usr/bin/env node
// A stand-in for Google's agy_acp_server, replaying the frames measured
// against the real server (research/antigravity-acp.md). State lives under
// GEMINI_HOME exactly where the real server keeps it, so host code that reads
// the server's files sees what it would see in production.
//
// Env: GEMINI_HOME (required), FAKE_AGY_SINK (JSONL of requests received),
// FAKE_AGY_SIGN_IN = approve (default) | deny | hang.
// FAKE_AGY_152 opts into the 1.5.2 Google catalog and session-open commands.
//
// `gateway` behaves as the real server's does (measured against 1.4.0 with a
// local fake of the Gemini API): refused as an unsupported method unless
// AGY_ACP_ENABLE_GATEWAY_AUTH is set; never written to settings.json; models
// listed from `<baseUrl>/v1beta/models` (no credential sent) with no
// thinking_level option; a turn POSTs `<baseUrl>/v1beta/models/<model>:
// streamGenerateContent?alt=sse` with `x-goog-api-key: dummy_api_key`, and an
// API refusal becomes the error's message as agent text. These are real HTTP
// calls, so a test can put the host's key relay in between.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const usageText = require("./agy-usage-text.json");

const home = process.env.GEMINI_HOME;
const acpDir = path.join(home, "antigravity-acp");
const settingsFile = path.join(acpDir, "settings.json");
const tokenFile = path.join(acpDir, "acp_token.json");
const conversations = path.join(acpDir, "conversations");
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 0;
const waiting = new Map();
const cancelled = new Set();
const sessions = new Map();
const version152 = process.env.FAKE_AGY_152 === "1";
let loggedOut = false;
// What `authenticate` selected in this process; settings.json otherwise.
let auth;

function write(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, value) { write({ method: "session/update", params: { sessionId, update: value } }); }
function sink(method, params) {
  if (process.env.FAKE_AGY_SINK) fs.appendFileSync(process.env.FAKE_AGY_SINK, JSON.stringify({ method, params }) + "\n");
}
function request(method, params) {
  const id = nextServerId++;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
function savedAuthType() {
  try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")).auth.type; } catch { return undefined; }
}
function rememberAuthType(type) {
  fs.mkdirSync(acpDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ auth: { type } }));
}
/** The method in force: the one authenticate chose, else settings.json's. */
function currentAuth() {
  if (loggedOut) return undefined;
  if (auth) return auth;
  const type = savedAuthType();
  if (type === "oauth-personal" && fs.existsSync(tokenFile)) return { method: type };
  return undefined;
}
function signedIn() { return !!currentAuth(); }
function gatewayBase() { return currentAuth()?.method === "gateway" ? currentAuth().baseUrl.replace(/\/+$/, "") : undefined; }
// gateway/model_discovery.py tier 4, when the gateway lists nothing.
const BUILTIN_GATEWAY_MODELS = ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"];
async function discoverGatewayModels() {
  try {
    const answer = await fetch(`${gatewayBase()}/v1beta/models?pageSize=1000`);
    if (answer.status !== 200) throw new Error(String(answer.status));
    const body = await answer.json();
    const ids = (body.models || [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => ({ value: String(model.name).replace(/^models\//, ""), name: model.displayName || String(model.name).replace(/^models\//, "") }));
    if (ids.length) return ids;
  } catch { /* falls through to the built-in list, as the server does */ }
  return BUILTIN_GATEWAY_MODELS.map((value) => ({ value, name: value }));
}
function authRequired() {
  return { code: -32000, message: "Authentication required", data: { message: "No authentication method selected." } };
}
const MODE_OPTION = { currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "auto_edit", name: "Auto Edit" }, { value: "yolo", name: "YOLO" }], id: "mode", name: "Session Mode", category: "mode", type: "select" };
const FAMILIES = (version152 ? ["Gemini 4 Neon", "Gemini 4 Carbon", "Gemini 4 Argon", "Gemini 4 Hydrogen", "Gemini 3.8 Flash"] : ["Gemini 3.8 Flash"])
  .map(name => ({ name, value: name.toLowerCase().replaceAll(" ", "-") }));
function levels(model) {
  const standard = ["low", "medium", "high"];
  return model === "gemini-4-neon" || model === "gemini-4-hydrogen" ? [...standard, "xhigh"] : standard;
}
function configOptions(session) {
  const mode = { ...MODE_OPTION, currentValue: session.mode ?? "default" };
  if (session?.gatewayModels) {
    // Gateway mode: models exactly as the gateway declares them, no thinking_level.
    return [{ currentValue: session.model, options: session.gatewayModels, id: "model", name: "Model", category: "model", type: "select" }, mode];
  }
  const level = session?.level ?? "high";
  return [
    { currentValue: session.model, options: FAMILIES, id: "model", name: "Model", category: "model", type: "select" },
    { currentValue: level, options: levels(session.model).map((value) => ({ value, name: value })), id: "thinking_level", name: "Thinking Level", category: "thought_level", type: "select" },
    mode,
  ];
}
function sessionResult(sessionId, session) {
  return {
    ...(sessionId ? { sessionId } : {}),
    modes: { currentModeId: session.mode ?? "default", availableModes: MODE_OPTION.options.map(({ value, name }) => ({ id: value, name })) },
    configOptions: configOptions(session),
    models: session?.gatewayModels
      ? { availableModels: session.gatewayModels.map(({ value, name }) => ({ modelId: value, name })), currentModelId: session.model }
      : { availableModels: FAMILIES.flatMap(({ value, name }) => levels(value).map(level => ({ modelId: `${value}-${level}`, name: `${name} (${level})` }))), currentModelId: `${session.model}-${session.level}` },
  };
}
async function newSessionState(cwd) {
  if (!gatewayBase()) return { cwd, model: "gemini-3.8-flash", level: "high" };
  const gatewayModels = await discoverGatewayModels();
  return { cwd, gatewayModels, model: gatewayModels[0].value };
}
/** One gateway turn: the harness's own call, dummy credential and all. */
async function gatewayTurn(sessionId, session, text) {
  const answer = await fetch(`${gatewayBase()}/v1beta/models/${session.model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "dummy_api_key" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], generationConfig: { maxOutputTokens: 65535 } }),
  });
  const body = await answer.text();
  if (answer.status !== 200) {
    let message = `Agent execution error: status ${answer.status}`;
    try { message = JSON.parse(body).error.message || message; } catch { /* keep the generic one */ }
    return update(sessionId, { content: { type: "text", text: message }, sessionUpdate: "agent_message_chunk" });
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    const part = event.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (part) update(sessionId, { content: { type: "text", text: part }, sessionUpdate: "agent_message_chunk" });
  }
}
function commands(sessionId) {
  update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
    { name: "plan", description: "Plan carefully" }, { name: "logout", description: "Log out" }, { name: "usage", description: "Show usage" },
    ...(version152 ? [{ name: "native-check", description: "Native command for the collision test" }] : []),
  ] });
}
function remember(sessionId, cwd) {
  fs.mkdirSync(conversations, { recursive: true });
  fs.writeFileSync(path.join(conversations, `${sessionId}.db`), "");
  fs.writeFileSync(path.join(conversations, `${sessionId}.meta`), JSON.stringify({ cwd }));
}

async function prompt(id, params) {
  const { sessionId } = params;
  const text = params.prompt?.map((block) => block.text ?? "").join(" ") ?? "";
  if (loggedOut) return write({ id, error: { code: -32000, message: "Logged out. Sign in again to continue." } });
  commands(sessionId);
  const session = sessions.get(sessionId);
  if (text === "/usage") {
    await request("session/request_permission", { sessionId, options: [{ optionId: "allow", kind: "allow_once" }] });
    update("unrelated-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Foreign output" } });
    const middle = usageText.indexOf("- **Claude");
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: usageText.slice(0, middle) } });
    write({ id, result: { stopReason: "end_turn" } });
    setTimeout(() => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: usageText.slice(middle) } }), 15);
    return;
  }
  if (session.gatewayModels) {
    await gatewayTurn(sessionId, session, text);
  } else if (/subagent/i.test(text)) {
    // Measured: the launch completes at once with the model's own summary, and
    // the child's call arrives on this session with nothing to attribute it.
    const launch = { toolCallId: "24ac72049c3b49ecac09e055152210cf", title: "Run invoke_subagent?", kind: "other", status: "pending",
      rawInput: { Subagents: [{ Model: "inherit", Prompt: "Read notes.txt and report what it says.", Role: "Project File Reader", TypeName: "research", Workspace: "inherit" }] } };
    update(sessionId, { ...launch, sessionUpdate: "tool_call" });
    await request("session/request_permission", { sessionId, toolCall: launch,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    update(sessionId, { toolCallId: launch.toolCallId, title: "Running invoke_subagent", kind: "other", status: "in_progress", rawInput: {}, sessionUpdate: "tool_call_update" });
    update(sessionId, { toolCallId: launch.toolCallId, status: "completed", rawOutput: "Invoke subagent", sessionUpdate: "tool_call_update" });
    update(sessionId, { toolCallId: "call_636537", title: "Running view_file", kind: "read", status: "in_progress",
      rawInput: { absolute_path: path.join(session.cwd, "notes.txt") }, locations: [{ path: path.join(session.cwd, "notes.txt") }], sessionUpdate: "tool_call" });
    update(sessionId, { content: { type: "text", text: "The subagent found the notes." }, sessionUpdate: "agent_message_chunk" });
    update(sessionId, { toolCallId: "call_636537", status: "completed", sessionUpdate: "tool_call_update" });
  } else if (/edit/i.test(text)) {
    // The approved edit is reported twice; the first is swept as failed.
    const target = path.join(session.cwd, "hello.txt");
    const approved = "b6f93483bd0942fa8b4b4751ca211cc3";
    const call = { toolCallId: approved, title: "Run create_file?", kind: "edit", status: "pending",
      content: [{ path: target, newText: "hi", _meta: { kind: "add" }, type: "diff" }], locations: [{ path: target }],
      rawInput: { CodeContent: "hi", TargetFile: target } };
    update(sessionId, { ...call, sessionUpdate: "tool_call" });
    const answer = await request("session/request_permission", { sessionId, toolCall: call,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    if (answer?.outcome?.optionId === "allow") {
      const running = `${sessionId}:1`;
      update(sessionId, { toolCallId: running, title: "Running edit_file", kind: "edit", status: "in_progress", locations: [{ path: target }], rawInput: { file_path: target }, sessionUpdate: "tool_call" });
      update(sessionId, { toolCallId: running, status: "completed", rawOutput: "Create hello.txt", sessionUpdate: "tool_call_update" });
      update(sessionId, { content: { type: "text", text: "Created hello.txt." }, sessionUpdate: "agent_message_chunk" });
      update(sessionId, { toolCallId: approved, status: "failed", rawOutput: "Tool call was approved but never executed.", sessionUpdate: "tool_call_update" });
    } else {
      update(sessionId, { toolCallId: approved, status: "failed", rawOutput: "Denied by user.", sessionUpdate: "tool_call_update" });
    }
  } else if (/run/i.test(text)) {
    const call = { toolCallId: "64aef4da43e841118774c470deebb567", kind: "execute", status: "pending", title: "echo done",
      rawInput: { CommandLine: "echo done", Cwd: session.cwd, WaitMsBeforeAsync: 5000 } };
    update(sessionId, { ...call, sessionUpdate: "tool_call" });
    const answer = await request("session/request_permission", { sessionId, toolCall: call, options: [
      { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    sink("permissionAnswer", answer);
    update(sessionId, { toolCallId: call.toolCallId, title: "echo done", kind: "execute", status: "in_progress",
      rawInput: { command_line: "echo done", working_dir: session.cwd }, sessionUpdate: "tool_call_update" });
    update(sessionId, { toolCallId: call.toolCallId, status: "completed", rawOutput: { commandLine: "echo done", workingDir: session.cwd,
      exitCode: 0, exit_code: 0, combinedOutput: "done\n", formatted_output: "done\n" }, sessionUpdate: "tool_call_update" });
  } else if (/slow/i.test(text)) {
    for (let index = 0; index < 400 && !cancelled.has(sessionId); index++) {
      update(sessionId, { content: { type: "text", text: `${index}. ` }, sessionUpdate: "agent_message_chunk" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (cancelled.delete(sessionId)) {
      update(sessionId, { content: { type: "text", text: "The request was cancelled by the client." }, sessionUpdate: "agent_message_chunk" });
      return write({ id, result: { stopReason: "cancelled" } });
    }
  } else {
    update(sessionId, { content: { type: "text", text: "OK" }, sessionUpdate: "agent_message_chunk" });
  }
  update(sessionId, { used: 13224, size: 1048576, sessionUpdate: "usage_update" });
  write({ id, result: { stopReason: "end_turn" } });
}

rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    if (message.error) sink("refusedRequest", message.error);
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  sink(method, params);
  switch (method) {
    case "initialize":
      return write({ id, result: { protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: version152 ? "1.5.2" : "1.4.0" } } });
    case "authenticate": {
      if (params.methodId === "gateway") {
        if (!/^(1|true|yes|on)$/i.test(String(process.env.AGY_ACP_ENABLE_GATEWAY_AUTH ?? "").trim())) {
          return write({ id, error: { code: -32602, message: "Unsupported auth method: 'gateway'" } });
        }
        const baseUrl = params._meta?.gateway?.baseUrl;
        if (typeof baseUrl !== "string" || !baseUrl) {
          return write({ id, error: { code: -32602, message: "authenticate(gateway): `_meta.gateway.baseUrl` is required and must be a non-empty string." } });
        }
        // Per connection, never persisted.
        auth = { method: "gateway", baseUrl };
        loggedOut = false;
        return write({ id, result: {} });
      }
      if (params.methodId !== "oauth-personal") return write({ id, error: { code: -32602, message: `Unsupported auth method: '${params.methodId}'` } });
      if (fs.existsSync(tokenFile)) {
        auth = { method: "oauth-personal" };
        loggedOut = false;
        rememberAuthType("oauth-personal");
        return write({ id, result: {} });
      }
      process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake\n");
      const mode = process.env.FAKE_AGY_SIGN_IN || "approve";
      if (mode === "hang") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "deny") return write({ id, error: { code: -32000, message: "Onboarding failed: denied" } });
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: "fake" }));
      rememberAuthType("oauth-personal");
      auth = { method: "oauth-personal" };
      loggedOut = false;
      return write({ id, result: {} });
    }
    case "logout":
      fs.rmSync(tokenFile, { force: true });
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({}));
      auth = undefined;
      loggedOut = true;
      sessions.clear();
      return write({ id, result: {} });
    case "session/new": {
      if (!signedIn()) return write({ id, error: authRequired() });
      const sessionId = `5e55${String(sessions.size).padStart(4, "0")}-0000-4000-8000-${String(process.pid).padStart(12, "0").slice(-12)}`;
      const session = await newSessionState(params.cwd);
      sessions.set(sessionId, session);
      remember(sessionId, params.cwd);
      if (process.env.FAKE_AGY_LOSE_METER_CREATE && params.cwd.endsWith("afk-pilot-meter")) process.exit(1);
      write({ id, result: sessionResult(sessionId, session) });
      if (version152) commands(sessionId);
      return;
    }
    case "session/resume":
    case "session/load": {
      if (!signedIn()) return write({ id, error: authRequired() });
      if (method === "session/resume" && !fs.existsSync(path.join(conversations, `${params.sessionId}.db`))) {
        return write({ id, error: { code: -32002, message: "Resource not found" } });
      }
      const session = await newSessionState(params.cwd);
      try { session.mode = JSON.parse(fs.readFileSync(path.join(conversations, `${params.sessionId}.meta`), "utf8")).mode; } catch { /* older fixture */ }
      sessions.set(params.sessionId, session);
      if (method === "session/load") {
        update(params.sessionId, { content: { type: "text", text: "Remember 41." }, sessionUpdate: "user_message_chunk" });
        update(params.sessionId, { content: { type: "text", text: "OK" }, sessionUpdate: "agent_message_chunk" });
      }
      write({ id, result: sessionResult(undefined, session) });
      if (version152) commands(params.sessionId);
      return;
    }
    case "session/list":
      return write({ id, result: { sessions: [...sessions].map(([sessionId, value]) => ({ sessionId, cwd: value.cwd, title: `Session ${sessionId.slice(0, 8)}` })) } });
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (!session) return write({ id, error: { code: -32002, message: "Resource not found" } });
      if (params.configId === "thinking_level") {
        if (session.gatewayModels) return write({ id, error: { code: -32602, message: "Unknown config option id: thinking_level" } });
        if (!levels(session.model).includes(params.value)) return write({ id, error: { code: -32602, message: "Unsupported thinking level" } });
        session.level = params.value;
      }
      if (params.configId === "model") {
        const offered = (session.gatewayModels ?? FAMILIES).map(option => option.value);
        if (!offered.includes(params.value)) return write({ id, error: { code: -32602, message: `Model '${params.value}' is not available for the current authentication method.` } });
        session.model = params.value;
        if (!levels(session.model).includes(session.level)) session.level = "high";
      }
      if (params.configId === "mode") {
        if (!MODE_OPTION.options.some(option => option.value === params.value)) return write({ id, error: { code: -32602, message: "Unsupported mode" } });
        session.mode = params.value;
        fs.writeFileSync(path.join(conversations, `${params.sessionId}.meta`), JSON.stringify({ cwd: session.cwd, mode: session.mode }));
      }
      return write({ id, result: { configOptions: configOptions(session) } });
    }
    case "session/set_mode":
      return write({ id, result: {} });
    case "session/cancel":
      cancelled.add(params.sessionId);
      return;
    case "session/prompt":
      return prompt(id, params);
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: "Method not found", data: { method } } });
  }
});
rl.on("close", () => process.exit(0));
