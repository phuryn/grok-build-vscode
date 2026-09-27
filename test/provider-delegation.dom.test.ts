import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AcpClient } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { grokBackend } from "../src/grok-backend";
import { childStreamFromRoute } from "../src/acp-dispatch";
import { parseRunProgressUpdate } from "../src/run-progress";
import { OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, transformHostMsgForRemote } from "../src/remote-policy";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

// Whitelisted fields from the 2026-09-26 captures. IDs and paths are neutral;
// the fixtures never include the original machine metadata or skill catalog.
const fixtures = JSON.parse(readFileSync(new URL("fixtures/provider-delegation.json", import.meta.url), "utf8"));
const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function view() {
  const h = bootWebview();
  windows.push(h.window);
  return h;
}
const backends = [grokBackend, new CodexBackend(), new ClaudeBackend(), new MuseBackend()];
function setup(provider: string, parent = "parent") {
  const desk = view(), phone = view();
  let replaying = false;
  const buffer: any[] = [];
  const client = new AcpClient({ cliPath: "unused", cwd: "/example", log: () => {},
    backend: backends.find(b => b.provider === provider)! });
  client.sessionId = parent;
  const emit = (msg: any) => {
    if (msg.type === "historyReplay") replaying = msg.active;
    buffer.push(structuredClone(msg));
    dispatch(desk.window, msg);
    dispatch(phone.window, structuredClone(transformHostMsgForRemote(msg, {} as any)));
  };
  client.on("toolCall", call => emit({ type: "toolCall", call }));
  client.on("toolCallUpdate", call => emit({ type: "toolCallUpdate", call }));
  client.on("messageChunk", text => emit({ type: "messageChunk", text }));
  client.on("userMessageChunk", text => emit({ type: "userMessageChunk", text }));
  client.on("notice", text => {
    if (replaying) emit({ type: "subagentUpdate", update: { sessionUpdate: "turn_completed" } });
    emit({ type: "planNotice", text });
  });
  client.on("childStream", ({ childSessionId, route }) => {
    const payload = childStreamFromRoute(childSessionId, route);
    if (payload) emit({ type: "childStream", ...payload });
  });
  const lifecycle = (update: any) => {
    const progress = parseRunProgressUpdate(update);
    emit(progress ? { type: "runProgress", update: progress } : { type: "subagentUpdate", update });
  };
  client.on("subagentLifecycle", lifecycle);
  client.on("xaiNotification", lifecycle);
  return { desk, phone, buffer, emit, client,
    accept: (update: any, sessionId = parent) => (client as any).handleSessionUpdate(update, undefined, sessionId),
    reopen: () => {
      const h = view();
      dispatch(h.window, { type: "historyReplay", active: true });
      for (const msg of buffer) dispatch(h.window, structuredClone(msg));
      dispatch(h.window, { type: "historyReplay", active: false });
      return h;
    },
  };
}
const frame = (h: Harness) => new Promise<void>(resolve => h.window.requestAnimationFrame(() => resolve()));

describe("provider delegation through the existing presentation wire", () => {
  it.each(["live", "load"])("Codex %s builds one card, owns child output, and keeps wait separate", async phase => {
    const rows = fixtures["codex-subagent-optin"].filter((r: any) => r.phase === phase);
    const s = setup("codex", rows[0].sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: true });
    if (phase === "load") {
      s.client.sessionId = undefined;
      (s.client as any).request = async () => {
        for (const row of rows) s.accept(row.update, row.sessionId);
        return {};
      };
      await s.client.loadSession(rows[0].sessionId);
    } else for (const row of rows) s.accept(row.update, row.sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: false });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelectorAll(".subagent-card")).toHaveLength(1);
      const card = h.doc.querySelector(".subagent-card")!;
      expect(card.classList.contains("subagent-done")).toBe(true);
      expect(card.querySelector(".subagent-stream")?.textContent).toContain("4");
      expect(card.querySelector(".subagent-title")?.textContent).toBe("Arithmetic");
      expect(h.doc.querySelector("#messages")?.textContent).not.toMatch(/Start subagent|Complete subagent/);
    }
    expect(s.buffer.filter(m => m.type === "toolCall" && m.call.title === "wait")).toHaveLength(phase === "live" ? 1 : 0);
  });

  it.each(["live", "load"])("Claude %s preserves the card, hand-back, duration and tokens without a child stream", phase => {
    const rows = fixtures["claude-subagent"].filter((r: any) => r.phase === phase);
    const s = setup("claude", rows[0].sessionId);
    for (const row of rows) s.accept(row.update, row.sessionId);
    for (const h of [s.desk, s.phone, s.reopen()]) {
      const card = h.doc.querySelector(".subagent-card")!;
      expect(card).not.toBeNull();
      expect(card.classList.contains("subagent-done")).toBe(true);
      expect(card.querySelector(".subagent-result")?.textContent).toContain("4");
      expect(card.querySelector(".subagent-result")?.textContent).not.toMatch(/hand-back|agentId|usage/);
      expect(card.querySelector(".subagent-time")?.textContent).toMatch(/2s.*tokens/);
    }
    expect(s.buffer.some(m => m.type === "childStream")).toBe(false);
  });

  it("Claude's marker is authoritative even when the first title is descriptive", () => {
    const s = setup("claude");
    s.accept({ sessionUpdate: "tool_call", toolCallId: "agent", title: "Compute four", kind: "think",
      _meta: { claudeCode: { toolName: "Agent", subagent: true } } });
    expect(s.desk.doc.querySelectorAll(".subagent-card")).toHaveLength(1);
  });

  it.each(["live", "load"])("Claude workflow %s has one unpinned launch receipt and a safe replay notice", async phase => {
    const rows = fixtures["claude-workflow"].filter((r: any) => r.phase === phase);
    const s = setup("claude", rows[0].sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: true });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Workflow launched." } });
    for (const row of rows) s.accept(row.update, row.sessionId);
    if (phase === "load") s.emit({ type: "historyReplay", active: false });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
      expect(h.doc.querySelector(".workflow-pin")).toBeNull();
      expect(h.doc.querySelector(".workflow-card")?.textContent).not.toMatch(/running|no recent updates|no update since/);
      expect(h.doc.querySelector(".workflow-card")?.textContent).toContain(phase === "load" ? "done" : "launched");
      expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
      expect(h.doc.querySelector("#messages")?.textContent).not.toContain("<task-notification>");
      expect(h.doc.querySelector("#messages")?.textContent).toContain("alpha beta");
      if (phase === "load") {
        const notice = h.doc.querySelector(".plan-notice")!;
        expect(notice.textContent).toBe("Background task completed.");
        const answer = [...h.doc.querySelectorAll(".msg.agent .body")].find(el => el.textContent?.trim() === "alpha beta");
        expect(answer).toBeDefined();
        expect(!!(notice.compareDocumentPosition(answer!) & 4)).toBe(true);
      }
    }
    expect(s.buffer.filter(m => m.type === "planNotice")).toHaveLength(phase === "load" ? 1 : 0);
    expect(s.buffer.some(m => m.type === "userMessageChunk")).toBe(false);
  });

  it.each([false, true])("Muse workflow roster and final summary survive history=%s and phone buffering", history => {
    const s = setup("muse");
    const p = new Projection(update => s.accept(update), () => {});
    const rows = fixtures["muse-workflow"];
    if (history) p.acceptHistory(rows.at(-1).item);
    else {
      for (const row of rows.slice(0, -1)) p.accept(row.method, { item: row.item });
      expect(s.buffer.filter(m => m.type === "runProgress").at(-1).update.done).toBe(false);
      expect(s.desk.doc.querySelectorAll(".workflow-pin .workflow-agent")).toHaveLength(2);
      expect(s.desk.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
      p.accept(rows.at(-1).method, { item: rows.at(-1).item });
      p.accept(rows.at(-1).method, { item: rows.at(-1).item }); // duplicate revision
    }
    expect(s.buffer.filter(m => m.type === "runProgress")).toHaveLength(history ? 1 : rows.length);
    for (const h of [s.desk, s.phone, s.reopen()]) {
      expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
      expect(h.doc.querySelectorAll(".workflow-agent")).toHaveLength(2);
      expect(h.doc.querySelector(".workflow-output-body")?.textContent).toMatch(/alpha[\s\S]*beta/);
      expect(h.doc.querySelector(".workflow-output-body code")?.textContent).toContain('"status": "ok"');
      expect(h.doc.querySelector(".workflow-pin")).toBeNull();
      expect(h.doc.querySelectorAll(".run-progress-btn")).toHaveLength(0);
    }
  });

  it.each(backends.map(b => b.provider))("%s accepts post-end_turn output once without a new prompt", async provider => {
    const s = setup(provider);
    s.emit({ type: "agentStart" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Launched. " } });
    s.emit({ type: "agentEnd" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "alpha beta" } });
    for (const h of [s.desk, s.phone, s.reopen()]) {
      await frame(h);
      expect(h.doc.querySelector("#messages")?.textContent?.match(/alpha beta/g)).toHaveLength(1);
    }
    expect(s.buffer.filter(m => m.type === "messageChunk" && m.text === "alpha beta")).toHaveLength(1);
  });

  it("Grok tool cards still use lifecycle tagging and finish through that rail", () => {
    const s = setup("grok");
    const call = { sessionUpdate: "tool_call", toolCallId: "grok-call", title: "spawn_subagent",
      _meta: { "x.ai/tool": { name: "spawn_subagent" } }, rawInput: { description: "Compute four", background: true } };
    expect(grokBackend.normalizeUpdate(call, undefined).update).toBe(call);
    s.accept(call);
    s.client.emit("xaiNotification", { sessionUpdate: "subagent_spawned", subagent_id: "child", child_session_id: "child" });
    s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "4" } }, "child");
    s.client.emit("xaiNotification", { sessionUpdate: "subagent_finished", subagent_id: "child", status: "completed", output: "4", duration_ms: 2353 });
    const card = s.desk.doc.querySelector(".subagent-card")!;
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".subagent-stream")?.textContent).toContain("4");
    expect(card.querySelector(".subagent-time")?.textContent).toContain("2s");
  });

  it("all reused messages remain mirrored and session-scoped", () => {
    for (const type of ["toolCall", "toolCallUpdate", "subagentUpdate", "childStream", "runProgress", "planNotice", "messageChunk"] as const) {
      expect(OUTBOUND_DISPOSITION[type]).toBe("mirror");
      expect(OUTBOUND_PROJECT_AUTH[type]).toBe("scope");
    }
  });
});

describe("paused workflow Markdown (#189)", () => {
  it.each(["grok", "muse"])("%s renders only the pause message with the Output sanitizer", provider => {
    const h = view();
    const update = parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "paused", name: "review",
      status: "user_paused", pause_message: "## Ready\n\n- Needs attention\n- Planning\n- Archive\n\n<script>bad()</script>",
      last_event: "stale event", last_event_detail: "leftover detail",
      ...(provider === "muse" ? { controlsAvailable: false } : {}) })!;
    dispatch(h.window, { type: "runProgress", update });
    const detail = h.doc.querySelector(".run-progress-detail")!;
    expect(detail.querySelector("h2")?.textContent).toBe("Ready");
    expect(detail.querySelectorAll("li")).toHaveLength(3);
    expect(detail.querySelector("script")).toBeNull();
    expect(detail.textContent).not.toMatch(/stale event|leftover detail/);
    dispatch(h.window, { type: "runProgress", update: { ...update, phase: "running", workflowContent: { pauseMessage: null, resultSummary: null } } });
    expect(h.doc.querySelector(".run-progress-detail")?.textContent).toBe("");
  });
});

it.each(["live", "load"])("Claude %s uses the launched name and description without claiming progress", phase => {
  const s = setup("claude");
  if (phase === "load") s.emit({ type: "historyReplay", active: true });
  if (phase === "live") s.accept({ sessionUpdate: "tool_call_update", toolCallId: "launch",
    _meta: { claudeCode: { toolName: "Workflow", toolResponse: { status: "async_launched",
      taskType: "local_workflow", runId: "wf-demo", taskId: "task-demo", workflowName: "greeting-demo", summary: "Write then shorten" } } } });
  s.accept({ sessionUpdate: "tool_call_update", toolCallId: "launch", status: "completed",
    _meta: { claudeCode: { toolName: "Workflow" } }, rawOutput:
      "Workflow launched in background. Task ID: task-demo\nSummary: Write then shorten\nScript file: /project/workflows/scripts/greeting-demo-wf-demo.js\nRun ID: wf-demo" });
  if (phase === "load") s.emit({ type: "historyReplay", active: false });
  s.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The workflow finished." } });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("greeting-demo");
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("launched");
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("Write then shorten");
    expect(h.doc.querySelector(".workflow-pin, .workflow-receipt, .run-progress-btn")).toBeNull();
  }
  s.accept({ sessionUpdate: "user_message_chunk", content: { type: "text", text:
    "<task-notification><task-id>task-demo</task-id><status>completed</status><result>Hello there friend</result></task-notification>" } });
  for (const h of [s.desk, s.phone, s.reopen()]) {
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("done");
    expect(h.doc.querySelector(".workflow-card")?.textContent).toContain("greeting-demo");
    expect(h.doc.querySelector(".workflow-card")?.textContent).not.toContain("Hello there friend");
    expect(h.doc.querySelector(".workflow-pin, .workflow-receipt, .run-progress-btn")).toBeNull();
  }
});
