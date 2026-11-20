import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { childStreamFromRoute } from "../src/acp-dispatch";
import { ClaudeBackend } from "../src/claude-backend";
import type { HostMsg } from "../src/protocol";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";
import { bootWebview, dispatch, type Harness } from "./webview-harness";
import background from "./fixtures/claude-background-subagent.json";

const sessionId = "11111111-2222-4333-8444-555555555555";
const agentId = "agent-tool";
const text = (value: string) => ({ type: "text", text: value });
const chunk = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: text(value) });
const child = (update: object, parentToolUseId = agentId, toolName?: string) => ({
  ...update, _meta: { claudeCode: { parentToolUseId, toolName } },
});
const tool = (toolCallId: string, title: string) => ({ sessionUpdate: "tool_call", toolCallId, title, kind: "read", status: "pending" });
const update = (client: AcpClient, frame: unknown, _meta?: object) => (client as any).onLine(JSON.stringify({
  jsonrpc: "2.0", method: "session/update", params: { sessionId, update: frame, _meta },
}));

const windows: Harness["window"][] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.happyDOM.abort();
  vi.unstubAllEnvs();
});

function view(remote = false) {
  const webview = bootWebview({ remote });
  windows.push(webview.window);
  return webview;
}

function setup(cwd = process.cwd()) {
  const backend = new ClaudeBackend();
  const log = vi.fn();
  const client = new AcpClient({ cliPath: "unused", cwd, log, backend });
  const frames: HostMsg[] = [];
  client.on("childStream", ({ childSessionId, route }) => {
    const payload = childStreamFromRoute(childSessionId, route);
    if (payload) frames.push({ type: "childStream", ...payload });
  });
  for (const event of ["toolCall", "toolCallUpdate"] as const) client.on(event, call => frames.push({ type: event, call }));
  client.on("messageChunk", (text, _meta, messageId) => frames.push({ type: "messageChunk", text, messageId }));
  client.on("userMessageChunk", text => frames.push({ type: "userMessageChunk", text }));
  return { client, frames, backend, log };
}

describe("Claude child stream", () => {
  it.each([false, true])("routes child activity before settlement (background=%s)", async (asyncAgent) => {
    const { client, frames } = setup();
    client.sessionId = sessionId;
    const occupancy = vi.fn();
    const titles = vi.fn();
    const usage = vi.fn();
    const plans = vi.fn();
    const parentThoughts = vi.fn();
    client.on("contextUsage", occupancy).on("sessionTitle", titles).on("adapterUsageUpdate", usage).on("plan", plans).on("thoughtChunk", parentThoughts);
    update(client, background.launch[0]);
    if (asyncAgent) for (const frame of background.launch.slice(1)) update(client, frame);
    update(client, child(chunk("agent_thought_chunk", "child thinking")));
    update(client, child({ ...chunk("agent_message_chunk", "child answer"), messageId: "child-reply" }), { totalTokens: 5000 });
    update(client, child(chunk("user_message_chunk", "private child prompt")));
    update(client, child({ sessionUpdate: "usage_update", used: 5000, size: 200000 }));
    update(client, child({ sessionUpdate: "plan", entries: [] }));
    update(client, child({ sessionUpdate: "session_info_update", title: "child title" }));
    update(client, child(tool("child-read", "Read child file"), agentId, "Read"));
    // Progress frames can omit the ancestry after the tool has been identified.
    update(client, { sessionUpdate: "tool_call_update", toolCallId: "child-read", status: "completed" });
    update(client, child(tool("nested", "Nested agent"), agentId, "Agent"));
    update(client, child(chunk("agent_message_chunk", "nested answer"), "nested"));
    update(client, { ...tool("parent-read", "Read parent file"), _meta: { claudeCode: { toolName: "Read" } } });
    update(client, { ...chunk("agent_message_chunk", "parent answer"), messageId: "parent-reply" });

    expect(frames[0]).toMatchObject({ type: "toolCall", call: { toolCallId: agentId, child_session_id: agentId } });
    expect(frames.filter(frame => frame.type === "childStream")).toMatchObject([
      { childSessionId: agentId, event: "thoughtChunk", text: "child thinking" },
      { childSessionId: agentId, event: "messageChunk", text: "child answer" },
      { childSessionId: agentId, event: "toolCall", call: { toolCallId: "child-read" } },
      { childSessionId: agentId, event: "toolCallUpdate", call: { toolCallId: "child-read", status: "completed" } },
      { childSessionId: agentId, event: "toolCall", call: { toolCallId: "nested" } },
      { childSessionId: agentId, event: "messageChunk", text: "nested answer" },
    ]);
    expect(frames.filter(frame => frame.type === "messageChunk" || frame.type === "userMessageChunk"))
      .toEqual([{ type: "messageChunk", text: "parent answer", messageId: "parent-reply" }]);
    expect(frames.filter(frame => frame.type === "toolCall").map(frame => frame.call.toolCallId)).toEqual([agentId, "parent-read"]);
    for (const listener of [occupancy, titles, usage, plans, parentThoughts]) expect(listener).not.toHaveBeenCalled();

    if (asyncAgent) {
      update(client, chunk("user_message_chunk", "<task-notification><task-id>agent-task</task-id><status>completed</status><result>hand-back</result></task-notification>"));
    } else {
      update(client, { sessionUpdate: "tool_call_update", toolCallId: agentId, status: "completed", rawOutput: [text("hand-back")] });
    }
    expect(frames.at(-1)).toMatchObject({ type: "toolCallUpdate", call: { child_session_id: agentId, status: "completed", rawOutput: { output: "hand-back" } } });
    const { doc, window } = view();
    for (const frame of frames) dispatch(window, frame);
    expect(doc.querySelectorAll(".subagent-card")).toHaveLength(1);
    expect(doc.querySelector(".subagent-stream")?.textContent).toContain("child answer");
    expect(doc.querySelector(".subagent-stream")?.textContent).toContain("nested answer");
    expect(doc.querySelector(".subagent-result")?.textContent).toContain("hand-back");

    if (asyncAgent) {
      const oldPhone = view(true);
      for (const frame of frames) if (frame.type !== "childStream") dispatch(oldPhone.window, frame);
      expect(oldPhone.doc.querySelectorAll(".subagent-card")).toHaveLength(1);
      expect(oldPhone.doc.querySelector(".subagent-result")?.textContent).toContain("hand-back");
      expect(oldPhone.doc.querySelector(".subagent-stream")?.textContent).toBe("");
    }
  });

  it("loads the bundled SDK's child transcripts beside their cards before the next parent turn", async () => {
    const cwd = mkdtempSync(join(process.cwd(), ".claude-child-history-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", cwd);
    vi.stubEnv("GROK_TEST_CLAUDE_ACP_ADAPTER_PATH", "");
    const project = join(cwd, "projects", "example");
    const children = join(project, sessionId, "subagents");
    mkdirSync(children, { recursive: true });
    const writeTranscript = (file: string, turns: ["user" | "assistant", unknown][]) => {
      const uuid = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const records = turns.map(([role, content], index) => ({
        type: role, uuid: uuid(index), parentUuid: index ? uuid(index - 1) : null, sessionId, cwd,
        timestamp: "2026-11-20T00:00:00.000Z", message: { role, content },
      }));
      writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    };
    try {
      writeTranscript(join(project, `${sessionId}.jsonl`), [["user", "Parent prompt"]]);
      writeTranscript(join(children, "agent-root.jsonl"), [
        ["user", "hidden child prompt"],
        ["assistant", [{ type: "thinking", thinking: "child thinking" }, text("first child answer"),
          { type: "tool_use", id: "nested", name: "Agent", input: { description: "Delegate again", prompt: "Nested task" } }]],
        ["user", [{ type: "tool_result", tool_use_id: "nested", content: "nested hand-back" }]],
        ["assistant", [text("second child answer")]],
      ]);
      writeFileSync(join(children, "agent-root.meta.json"), JSON.stringify({ toolUseId: agentId }));
      writeTranscript(join(children, "agent-grandchild.jsonl"), [["assistant", [text("nested answer")]]]);
      writeFileSync(join(children, "agent-grandchild.meta.json"), JSON.stringify({ toolUseId: "nested", parentAgentId: "root" }));
      writeTranscript(join(children, "agent-workflow.jsonl"), [["assistant", [text("unmatched workflow sidechain")]]]);
      writeFileSync(join(children, "agent-workflow.meta.json"), JSON.stringify({ toolUseId: "workflow" }));

      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      expect((await sdk.getSessionMessages(sessionId)).map(message => message.parent_tool_use_id)).toEqual([null]);
      expect(await sdk.listSubagents(sessionId)).toEqual(expect.arrayContaining(["root", "grandchild", "workflow"]));
      const { client, frames, backend, log } = setup(cwd);
      const prepareChildReplay = vi.spyOn(backend, "prepareChildReplay");
      const request = vi.fn(async (method: string) => {
        if (method === "session/load") {
          update(client, chunk("user_message_chunk", "Parent prompt"));
          update(client, background.launch[0]);
          update(client, { sessionUpdate: "tool_call_update", toolCallId: agentId, status: "completed", rawOutput: "hand-back" });
          update(client, chunk("agent_message_chunk", "Parent answer"));
          update(client, chunk("user_message_chunk", "Next parent prompt"));
        }
        return {};
      });
      (client as any).request = request;
      await client.loadSession(sessionId);
      await prepareChildReplay.mock.results[0].value;
      expect(log.mock.calls.flat().join("\n")).not.toMatch(/handler error|Could not read child history/);
      expect(request.mock.calls[0][0]).toBe("session/load");
      expect(frames.map(frame => frame.type === "childStream" ? frame.event : frame.type)).toEqual([
        "userMessageChunk", "toolCall", "thoughtChunk", "messageChunk", "toolCall", "messageChunk",
        "toolCallUpdate", "messageChunk", "toolCallUpdate", "messageChunk", "userMessageChunk",
      ]);
      expect(frames.filter(frame => frame.type === "childStream" && frame.event === "messageChunk")).toMatchObject([
        { childSessionId: agentId, text: "first child answer" },
        { childSessionId: agentId, text: "nested answer" },
        { childSessionId: agentId, text: "second child answer" },
      ]);
      expect(frames.filter(frame => frame.type === "userMessageChunk").map(frame => frame.text)).toEqual(["Parent prompt", "Next parent prompt"]);

      const { doc, window } = view();
      (window as any).__grokHistoryWindow = 1;
      dispatch(window, { type: "historyReplay", active: true });
      for (const frame of frames) dispatch(window, frame);
      dispatch(window, { type: "historyReplay", active: false });
      expect(doc.querySelector(".subagent-card")).toBeNull();
      expect((window as any).__grokHistory.expandMore()).toBe(true);
      const card = doc.querySelector(".subagent-card")!;
      expect(card.getAttribute("data-child-session-id")).toBe(agentId);
      expect([...card.querySelectorAll(".subagent-prose")].map(el => el.textContent)).toEqual([
        "first child answer", "nested answersecond child answer",
      ]);
      expect([...doc.querySelectorAll(".msg.user .body")].map(el => el.textContent)).toEqual(["Parent prompt", "Next parent prompt"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["local", "remote"] as const)("answers a child-only tool's permission from the %s card", async (origin) => {
    const { client, frames } = setup();
    client.sessionId = sessionId;
    const written: unknown[] = [];
    (client as any).proc = { killed: false, stdin: { writable: true, write: (line: string) => written.push(JSON.parse(line)) } };
    const session = new Session();
    session.provider = "claude";
    session.client = client;
    session.cwd = process.cwd();
    const webview = view(origin === "remote");
    const sidebar = Object.create(GrokSidebar.prototype);
    const remoteClients = new RemoteClientState<Session>(session.cwd);
    remoteClients.ready("phone");
    remoteClients.setActive("phone", session);
    Object.assign(sidebar, {
      focused: session, remoteClients, pendingTurnDiffCaptures: new Map(),
      view: origin === "local" ? { webview: { postMessage: (msg: HostMsg) => dispatch(webview.window, msg) } } : undefined,
      sendRemoteClient: (_clientId: string, msg: HostMsg) => { if (origin === "remote") dispatch(webview.window, msg); },
      localizeHistoryMessage: (msg: HostMsg) => msg,
      authorizedSessionCwds: () => [session.cwd], workspaceRoot: () => session.cwd,
      host: { workspaceRoot: () => session.cwd, appendLine: vi.fn() },
      state: { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) },
      captureRemoteRequester: vi.fn(), mirrorToProjectsRail: vi.fn(), closeDiffForRequest: vi.fn(),
      setStatus: vi.fn(), noteAnswered: vi.fn(),
    });
    client.on("permissionRequest", req => sidebar.handlePermissionRequest(session, client, req, session.cwd));

    update(client, background.launch[0]);
    const call = child(tool("child-read", "Read child file"), agentId, "Read");
    update(client, call);
    for (const frame of frames) dispatch(webview.window, frame);
    expect(webview.doc.querySelector(".subagent-tool")?.getAttribute("data-tool-call-id")).toBe("child-read");
    expect(frames.filter(frame => frame.type === "toolCall").map(frame => frame.call.toolCallId)).toEqual([agentId]);
    (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "session/request_permission", params: {
      sessionId, toolCall: call, options: [{ optionId: "allow-child", kind: "allow_once", name: "Allow once" }],
    } }));
    expect(session.pendingPermissions.get(91)?.toolCallId).toBe("child-read");
    const button = webview.doc.querySelector<HTMLButtonElement>(".card.permission .card-actions button")!;
    expect(button.textContent).toContain("Allow once");
    button.click();
    const answer = webview.posted.find(message => message.type === "permissionAnswer");
    expect(answer).toEqual({ type: "permissionAnswer", requestId: 91, optionId: "allow-child" });
    await sidebar.onMessage(answer, origin, origin === "remote" ? "phone" : undefined);
    expect(written).toEqual([{ jsonrpc: "2.0", id: 91, result: { outcome: { outcome: "selected", optionId: "allow-child" } } }]);
    expect(session.pendingPermissions.has(91)).toBe(false);
  });
});
