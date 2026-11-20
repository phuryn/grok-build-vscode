const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

if (process.argv[2] !== "acp") process.exit(2);
if (process.env.FAKE_AGY_CLI_BROKEN === "1") process.exit(3);
const store = path.join(process.env.GEMINI_HOME, "antigravity-cli", "conversations");
const sink = process.env.FAKE_AGY_CLI_SINK;
const write = payload => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
const update = (sessionId, sessionUpdate, fields) => write({ method: "session/update", params: { sessionId, update: { sessionUpdate, ...fields } } });
const text = (sessionId, content, type = "agent_message_chunk") => update(sessionId, type, { content: { type: "text", text: content } });
const commands = ["goal", "compact", "plan"].map(name => ({ name, description: name }));
const modes = ["default", "accept-edits", "auto", "plan"];
let session;
let prior;
let complete;

function result() {
  const options = values => values.map(value => ({ value, name: value }));
  return {
    sessionId: session.sessionId,
    configOptions: [
      { id: "model", currentValue: "claude-sonnet-5-5", options: options(["claude-sonnet-5-5", "gpt-oss-120b-medium"]) },
      { id: "thought_level", currentValue: session.effort, options: options(["low", "medium", "high"]) },
      { id: "mode", currentValue: session.mode, options: options(modes) },
    ],
  };
}
function finish(id) { write({ id, result: { stopReason: "end_turn" } }); }

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (sink) fs.appendFileSync(sink, JSON.stringify({ method, params }) + "\n");
  switch (method) {
    case "initialize":
      return write({ id, result: { protocolVersion: 1, agentInfo: { version: "1.5.8" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} } } } });
    case "session/new":
      fs.mkdirSync(store, { recursive: true });
      session = { sessionId: "fake-cli-" + process.pid, cwd: params.cwd, mode: "default", effort: "high", title: "Native CLI history" };
      fs.writeFileSync(path.join(store, session.sessionId + ".db"), JSON.stringify(session));
      write({ id, result: result() });
      return update(session.sessionId, "available_commands_update", { availableCommands: commands });
    case "session/list": {
      const entries = fs.existsSync(store) ? fs.readdirSync(store).map(file => JSON.parse(fs.readFileSync(path.join(store, file), "utf8"))) : [];
      return write({ id, result: params.cursor ? { sessions: entries } : { sessions: [], nextCursor: "next" } });
    }
    case "session/load":
      session = JSON.parse(fs.readFileSync(path.join(store, params.sessionId + ".db"), "utf8"));
      text(session.sessionId, "previous conversation");
      return write({ id, result: result() });
    case "session/set_config_option":
      if (params.configId === "mode" && modes.includes(params.value)) session.mode = params.value;
      else if (params.configId === "thought_level") session.effort = params.value;
      else return write({ id, error: { code: -32602, message: "Unsupported config change" } });
      fs.writeFileSync(path.join(store, session.sessionId + ".db"), JSON.stringify(session));
      return write({ id, result: result() });
    case "session/prompt": {
      const prompt = params.prompt[0].text;
      if (prompt === "first") {
        prior = id;
        return text(session.sessionId, "started");
      }
      if (prompt === "reject steer") return write({ id, error: { code: -32602, message: "refused" } });
      if (prior !== undefined) {
        finish(prior);
        prior = id;
        text(session.sessionId, prompt, "user_message_chunk");
        return text(session.sessionId, "steering pending");
      }
      if (prompt === "finish plan") {
        update(session.sessionId, "plan", { entries: [{ content: "Outline the work", status: "completed", priority: "medium" }] });
        complete = id;
        return write({ id: "plan-review", method: "session/request_permission", params: { sessionId: session.sessionId,
          toolCall: { kind: "switch_mode", toolCallId: "review", title: "Review plan", rawInput: { plan: "Outline the work" } },
          options: [{ optionId: "deny", kind: "reject_once", name: "Keep planning" }],
        } });
      }
      text(session.sessionId, prompt === "/compact" ? "CLI compact reply" : "finished " + prompt);
      return finish(id);
    }
    case "session/cancel":
      if (prior !== undefined) {
        text(session.sessionId, "final output");
        finish(prior);
        prior = undefined;
      }
      return;
    case "logout":
      // The real CLI clears its own stored sign-in (agentCapabilities.auth.logout, 1.5.8).
      fs.mkdirSync(path.join(process.env.GEMINI_HOME, "antigravity-cli"), { recursive: true });
      fs.writeFileSync(path.join(process.env.GEMINI_HOME, "antigravity-cli", "signed-out"), "");
      return write({ id, result: {} });
    default:
      if (id === "plan-review") return finish(complete);
      if (id !== undefined) return write({ id, error: { code: -32601, message: "Unknown method" } });
  }
});
