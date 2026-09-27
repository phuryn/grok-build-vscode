// Electron entry used ONLY by smoke-render.mjs. The real desktop entry and
// handlers still run; wrappers record boundaries before forwarding unchanged.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = process.env.ACP_SMOKE_RENDER_OUTPUT;
if (!output) throw new Error("ACP_SMOKE_RENDER_OUTPUT is required");
const profile = process.env.ACP_SMOKE_RENDER_PROFILE;
const trace = path.join(output, "desktop-wire.jsonl");
const state = globalThis.__renderSmoke = { scenario: "startup", events: [], clients: new Set(), pendingPrompts: new Set(), delivery: "unarmed" };
const ids = new WeakMap();
let nextClient = 0;
const clientId = client => { if (!ids.has(client)) ids.set(client, ++nextClient); return ids.get(client); };
const record = (direction, message, extra = {}) => {
  const event = { at: new Date().toISOString(), scenario: state.scenario, direction, message, ...extra };
  // Synchronous capture is intentional: failed evidence writes fail the run.
  fs.appendFileSync(trace, JSON.stringify(event) + "\n");
  state.events.push(event);
};

// Isolate host preferences without relocating any provider's credentials/home.
const persisted = require(path.join(root, "out/persisted-state.js"));
persisted.PersistedState = new Proxy(persisted.PersistedState, {
  construct(Target, args) { args[1] = path.join(profile, "client-state"); return Reflect.construct(Target, args); },
});
const sidebarModule = require(path.join(root, "out/sidebar.js"));
sidebarModule.GrokSidebar = new Proxy(sidebarModule.GrokSidebar, {
  construct(Target, args) {
    state.sidebar = Reflect.construct(Target, args);
    // This instrument checks the installed CLI, never upgrades/downgrades it.
    state.sidebar.cliUpdateChecked = true;
    state.sidebar.brokenCliPinned = true;
    return state.sidebar;
  },
});
const { AcpClient } = require(path.join(root, "out/acp.js"));
const start = AcpClient.prototype.start;
const instrumentedBackends = new WeakSet();
AcpClient.prototype.start = function (...args) {
  if (!state.clients.has(this)) {
    const log = this.opts.log;
    this.opts.log = (...values) => { record("host-log", { text: values.map(String).join(" ") }); return log.apply(this.opts, values); };
  }
  state.clients.add(this);
  if (!instrumentedBackends.has(this.backend)) {
    instrumentedBackends.add(this.backend);
    const normalize = this.backend.normalizeUpdate.bind(this.backend);
    this.backend.normalizeUpdate = (raw, meta) => {
      const result = normalize(raw, meta);
      record("normalized", { raw, result }, { provider: this.provider,
        ignored: !Object.entries(result).some(([key, value]) => key !== "meta" && value !== undefined) });
      return result;
    };
  }
  return start.apply(this, args);
};
const write = AcpClient.prototype.writeLine;
AcpClient.prototype.writeLine = function (message) {
  record("send", message, { provider: this.provider, clientId: clientId(this) });
  if (message.method === "session/prompt") state.pendingPrompts.add(`${clientId(this)}:${message.id}`);
  return write.call(this, message);
};
const onLine = AcpClient.prototype.onLine;
AcpClient.prototype.onLine = function (line) {
  let message;
  try { message = JSON.parse(line); }
  catch { record("protocol-error", { line }); }
  if (message) {
    record("receive", message, { provider: this.provider, clientId: clientId(this) });
    if (!message.method) state.pendingPrompts.delete(`${clientId(this)}:${message.id}`);
  }
  const result = onLine.call(this, line);
  if (this.provider === "muse" && state.delivery === "armed" && state.workflowDone
      && !state.pendingPrompts.size && message?.method === "session/update"
      && message.params?.sessionId === this.sessionId
      && message.params.update?.sessionUpdate === "agent_message_chunk"
      && message.params.update.content?.text?.trim()) {
    state.delivery = "observed";
    state.scenario = "delivery prompt";
    record("delivery-observation", { sessionId: this.sessionId });
    // Drive the real host send handler while this unprompted turn is speaking.
    // Never call client.prompt directly: host admission/queuing is part of the test.
    void state.sidebar.onMessage({ type: "send", text: state.deliveryText }, "local")
      .catch(error => record("host-error", { text: String(error) }));
  }
  return result;
};
const route = AcpClient.prototype.handleSessionUpdate;
AcpClient.prototype.handleSessionUpdate = function (raw, ...args) {
  const emit = this.emit;
  const emitted = [];
  this.emit = function (name, ...values) { emitted.push(name); return emit.call(this, name, ...values); };
  try { return route.call(this, raw, ...args); }
  finally {
    this.emit = emit;
    record("routed", { raw, emitted }, { ignored: emitted.length === 0 });
  }
};
const { ElectronWebview } = require(path.join(root, "out/desktop/electron-webview.js"));
const post = ElectronWebview.prototype.postMessage;
ElectronWebview.prototype.postMessage = function (message) {
  record("host-to-webview", message);
  if (message.type === "runProgress" && message.update?.done && !message.update.failed && !message.update.cancelled) state.workflowDone = true;
  const result = post.call(this, message);
  if (message.type === "permissionRequest") {
    const option = message.req?.options?.find(o => o.kind === "allow_once");
    if (option) queueMicrotask(() => void state.sidebar.onMessage({ type: "permissionAnswer", requestId: message.req.id, optionId: option.optionId }, "local")
      .catch(error => record("host-error", { text: String(error) })));
  }
  return result;
};
state.mark = name => { state.scenario = name; record("scenario", { name }); };
state.status = () => ({
  provider: state.sidebar?.focused?.provider,
  sessionId: state.sidebar?.focused?.client?.sessionId,
  models: state.sidebar?.focused?.client?.availableModels,
  modelId: state.sidebar?.focused?.client?.currentModelId,
  effort: state.sidebar?.focused?.client?.currentReasoningEffort,
  pendingPrompts: state.pendingPrompts.size, delivery: state.delivery,
  workflowDone: !!state.workflowDone,
  events: state.events,
});
// Catch startup exceptions before Playwright obtains the first window.
require("electron").app.on("web-contents-created", (_, contents) => {
  contents.on("console-message", (_, level, message) => {
    if (level >= 2 && /^Uncaught\b/.test(message)) record("page-error", { text: message });
  });
  contents.on("render-process-gone", (_, details) => {
    if (details.reason !== "clean-exit") record("page-error", { text: `renderer exited: ${details.reason}` });
  });
});
require(path.join(root, "out/desktop/main.js"));
