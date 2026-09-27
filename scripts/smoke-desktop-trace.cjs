// Passive Node preload, NOT an Electron entry point. No sidebar actions, globals,
// approvals, preference overrides or provider disposal. The real main owns life cycle.
const fs = require("node:fs");
const path = require("node:path");

function installTrace({ AcpClient, ElectronWebview }, record) {
  const ids = new WeakMap(), requests = new WeakMap(), configs = new WeakMap();
  const backends = new WeakSet(), clients = new WeakSet();
  let nextId = 0;
  const identity = client => {
    if (!ids.has(client)) ids.set(client, ++nextId);
    return { clientId: ids.get(client), provider: client.provider };
  };
  const start = AcpClient.prototype.start;
  AcpClient.prototype.start = function (...args) {
    if (!clients.has(this)) {
      clients.add(this);
      const log = this.opts.log, owner = this;
      this.opts.log = function (...values) {
        record("host-log", { text: values.map(String).join(" ") }, identity(owner));
        return log.apply(this, values);
      };
    }
    if (!backends.has(this.backend)) {
      backends.add(this.backend);
      const normalize = this.backend.normalizeUpdate;
      this.backend.normalizeUpdate = function (...values) {
        const result = normalize.apply(this, values);
        record("normalized", { raw: values[0], result }, {
          ignored: !Object.entries(result).some(([key, value]) => key !== "meta" && value !== undefined),
        });
        return result;
      };
    }
    return start.apply(this, args);
  };
  const write = AcpClient.prototype.writeLine;
  AcpClient.prototype.writeLine = function (message) {
    if (!requests.has(this)) requests.set(this, new Map());
    if (message.id != null && message.method) requests.get(this).set(message.id, message);
    record("send", message, identity(this));
    return write.call(this, message);
  };
  const onLine = AcpClient.prototype.onLine;
  AcpClient.prototype.onLine = function (line) {
    let message;
    try { message = JSON.parse(line); } catch { record("protocol-error", { line }, identity(this)); }
    if (message) {
      record("receive", message, identity(this));
      const request = !message.method && requests.get(this)?.get(message.id);
      if (request) {
        requests.get(this).delete(message.id);
        if (["session/new", "session/load", "session/set_model", "session/set_config_option"].includes(request.method)
            && Array.isArray(message.result?.configOptions)) configs.set(this, message.result.configOptions);
      }
    }
    return onLine.call(this, line);
  };
  const route = AcpClient.prototype.handleSessionUpdate;
  AcpClient.prototype.handleSessionUpdate = function (raw, ...args) {
    const emit = this.emit, emitted = [];
    this.emit = function (name, ...values) { emitted.push(name); return emit.call(this, name, ...values); };
    try { return route.call(this, raw, ...args); }
    finally { this.emit = emit; record("routed", { raw, emitted }, { ...identity(this), ignored: !emitted.length }); }
  };
  // Record acknowledged, normalized client facts at operation completion. No
  // polling and no mirror implementation of provider model/config normalization.
  for (const method of ["newSession", "loadSession", "setModel", "setReasoningEffort"]) {
    const original = AcpClient.prototype[method];
    AcpClient.prototype[method] = async function (...args) {
      const result = await original.apply(this, args);
      record("client-state", { operation: method, sessionId: this.sessionId,
        modelId: this.currentModelId, models: this.availableModels,
        effort: this.currentReasoningEffort, configOptions: configs.get(this) }, identity(this));
      return result;
    };
  }
  const post = ElectronWebview.prototype.postMessage;
  ElectronWebview.prototype.postMessage = function (message) {
    record("host-to-webview", message);
    return post.call(this, message);
  };
}

module.exports = { installTrace };
// Only the Electron browser/main process may install taps, even if a child
// inherits execArgv; ELECTRON_RUN_AS_NODE children must remain untouched.
if (process.type === "browser" && process.env.ACP_SMOKE_RENDER_OUTPUT) {
  const root = path.resolve(__dirname, "..");
  const trace = path.join(process.env.ACP_SMOKE_RENDER_OUTPUT, "desktop-wire.jsonl");
  const record = (direction, message, extra = {}) => fs.appendFileSync(trace,
    JSON.stringify({ at: new Date().toISOString(), direction, message, ...extra }) + "\n");
  installTrace({ ...require(path.join(root, "out/acp.js")), ...require(path.join(root, "out/desktop/electron-webview.js")) }, record);
  require("electron").app.on("web-contents-created", (_, contents) => {
    contents.on("console-message", (_, level, message) => {
      if (level >= 2 && /^Uncaught\b/.test(message)) record("page-error", { text: message });
    });
    contents.on("render-process-gone", (_, details) => {
      if (details.reason !== "clean-exit") record("page-error", { text: `renderer exited: ${details.reason}` });
    });
  });
  record("trace-ready", { pid: process.pid, entry: process.argv[1] });
}
