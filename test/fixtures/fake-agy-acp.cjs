#!/usr/bin/env node
// Fake agy ACP transport for isolated Google sign-in, key sign-in and tool replay.
if (process.argv[2] !== "acp") process.exit(2);
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const flag = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const home = flag("--gemini-dir") ?? process.env.GEMINI_HOME;
if (!home) throw new Error("A throwaway Gemini home is required.");
const acpDir = path.join(home, flag("--app-data-dir") ?? "antigravity-cli");
const settingsFile = path.join(acpDir, "settings.json");
const tokenFile = path.join(acpDir, "acp_token.json");
const conversations = path.join(acpDir, "conversations");
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 0;
const waiting = new Map();
const cancelled = new Set();
const sessions = new Map();
const extendedCatalog = process.env.FAKE_AGY_EXTENDED_CATALOG === "1";
const forkHistory = process.env.FAKE_AGY_FORK_HISTORY === "1";
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
/** The method in force: the one authenticate chose, else settings.json's. */
function currentAuth() {
  if (loggedOut) return undefined;
  if (auth) return auth;
  const type = savedAuthType();
  if (type === "oauth-personal" && fs.existsSync(tokenFile)) return { method: type };
  return undefined;
}
function signedIn() { return !!currentAuth(); }
function authRequired() {
  return { code: -32000, message: "Authentication required", data: { message: "No authentication method selected." } };
}
const MODE_OPTION = { currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }, { value: "plan", name: "Plan" }], id: "mode", name: "Session Mode", category: "mode", type: "select" };
const FAMILIES = (extendedCatalog ? ["Gemini 4 Neon", "Gemini 4 Carbon", "Gemini 4 Argon", "Gemini 4 Hydrogen", "Gemini 3.8 Flash"] : ["Gemini 3.8 Flash"])
  .map(name => ({ name, value: name.toLowerCase().replaceAll(" ", "-") }));
function levels(model) {
  const standard = ["low", "medium", "high"];
  return model === "gemini-4-neon" || model === "gemini-4-hydrogen" ? [...standard, "xhigh"] : standard;
}
function configOptions(session) {
  const mode = { ...MODE_OPTION, currentValue: session.mode ?? "default" };
  const level = session?.level ?? "high";
  return [
    { currentValue: session.model, options: FAMILIES, id: "model", name: "Model", category: "model", type: "select" },
    { currentValue: level, options: levels(session.model).map((value) => ({ value, name: value })), id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select" },
    mode,
  ];
}
function sessionResult(sessionId, session) {
  return {
    ...(sessionId ? { sessionId } : {}),
    modes: { currentModeId: session.mode ?? "default", availableModes: MODE_OPTION.options.map(({ value, name }) => ({ id: value, name })) },
    configOptions: configOptions(session),
    models: { availableModels: FAMILIES.flatMap(({ value, name }) => levels(value).map(level => ({ modelId: `${value}-${level}`, name: `${name} (${level})` }))), currentModelId: `${session.model}-${session.level}` },
  };
}
function newSessionState(cwd) {
  return { cwd, model: "gemini-3.8-flash", level: "high" };
}
function transcriptPath(sessionId) {
  return path.join(conversations, `${sessionId}.fixture.jsonl`);
}
function forkPrompt(id, { sessionId, prompt: blocks }) {
  const text = blocks.at(-1)?.text ?? "";
  const fail = /refuse (before|after) saving/.exec(text)?.[1];
  const reject = () => {
    const text = blocks[0].text;
    process.stderr.write(text + "\n");
    process.stdout.write("Diagnostic: " + text.replaceAll("\n", "\\n") + "\n");
    write({ id, error: { code: -32002, message: text, data: { copy: text } } });
  };
  if (fail === "before") return reject();
  const stream = [
    ...blocks.map(content => ({ sessionUpdate: "user_message_chunk", content })),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply to " } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private thinking" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  ];
  fs.appendFileSync(transcriptPath(sessionId), JSON.stringify(stream) + "\n");
  if (fail === "after") return reject();
  for (const item of stream) update(sessionId, item);
  write({ id, result: { stopReason: "end_turn" } });
}
function commands(sessionId) {
  update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
    { name: "plan", description: "Plan carefully" }, { name: "logout", description: "Log out" }, { name: "compact", description: "Compact" },
    ...(extendedCatalog ? [{ name: "native-check", description: "Native command for the collision test" }] : []),
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
  if (auth?.method === "gemini-api-key" && process.env.FAKE_AGY_REFUSE_KEY) {
    update(sessionId, { content: { type: "text", text: "API key not valid. Please pass a valid API key." }, sessionUpdate: "agent_message_chunk" });
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
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }],
        agentInfo: { name: "Antigravity ACP Server", title: "Google Antigravity", version: "1.5.8" } } });
    case "authenticate": {
      if (params.methodId === "gemini-api-key") {
        if (!process.env.GEMINI_API_KEY) return write({ id, error: authRequired() });
        sink("keyPresent", { present: true, onlyInEnv: !process.argv.some(arg => arg.includes(process.env.GEMINI_API_KEY)) });
        auth = { method: "gemini-api-key" };
        loggedOut = false;
        return write({ id, result: {} });
      }
      if (params.methodId !== "oauth-personal") return write({ id, error: { code: -32602, message: `Unsupported auth method: '${params.methodId}'` } });
      if (fs.existsSync(tokenFile)) {
        auth = { method: "oauth-personal" };
        loggedOut = false;
        return write({ id, result: {} });
      }
      process.stderr.write("Open this link: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake\n");
      const mode = process.env.FAKE_AGY_SIGN_IN || "approve";
      if (mode === "hang") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "deny") return write({ id, error: { code: -32000, message: "Onboarding failed: denied" } });
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: "fake" }));
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
      write({ id, result: sessionResult(sessionId, session) });
      if (extendedCatalog) commands(sessionId);
      return;
    }
    case "session/resume":
    case "session/load": {
      if (!signedIn()) return write({ id, error: authRequired() });
      if (!fs.existsSync(path.join(conversations, `${params.sessionId}.db`))) {
        return write({ id, error: { code: -32002, message: "Resource not found" } });
      }
      const session = await newSessionState(params.cwd);
      try { session.mode = JSON.parse(fs.readFileSync(path.join(conversations, `${params.sessionId}.meta`), "utf8")).mode; } catch { /* older fixture */ }
      sessions.set(params.sessionId, session);
      if (method === "session/load") {
        if (forkHistory) {
          const file = transcriptPath(params.sessionId);
          if (fs.existsSync(file)) {
            for (const line of fs.readFileSync(file, "utf8").trimEnd().split("\n")) {
              for (const item of JSON.parse(line)) update(params.sessionId, item);
            }
          }
        } else {
          update(params.sessionId, { content: { type: "text", text: "Remember 41." }, sessionUpdate: "user_message_chunk" });
          update(params.sessionId, { content: { type: "text", text: "OK" }, sessionUpdate: "agent_message_chunk" });
        }
      }
      write({ id, result: sessionResult(undefined, session) });
      if (extendedCatalog) commands(params.sessionId);
      return;
    }
    case "session/list":
      return write({ id, result: { sessions: [...sessions].map(([sessionId, value]) => ({ sessionId, cwd: value.cwd, title: `Session ${sessionId.slice(0, 8)}` })) } });
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (!session) return write({ id, error: { code: -32002, message: "Resource not found" } });
      if (params.configId === "thought_level") {
        if (!levels(session.model).includes(params.value)) return write({ id, error: { code: -32602, message: "Unsupported thinking level" } });
        session.level = params.value;
      }
      if (params.configId === "model") {
        const offered = FAMILIES.map(option => option.value);
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
      return forkHistory && signedIn() && sessions.has(params.sessionId) ? forkPrompt(id, params) : prompt(id, params);
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: "Method not found", data: { method } } });
  }
});
rl.on("close", () => process.exit(0));
