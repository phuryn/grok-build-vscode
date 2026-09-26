import { expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { commandOutputForToolCall } from "../src/acp-dispatch";
import { bootWebview, dispatch } from "./webview-harness";
import type { Window } from "happy-dom";

/** Same order as the host replay hook: the tool update, then at most one
 * commandOutput for that tool call. The payload has no toolCallId. */
function replayMuseHistory(window: Window, items: Record<string, any>[]) {
  const updates: any[] = [];
  const projection = new Projection(update => updates.push(update), () => {});
  const remembered = new Map<string, string>();
  const emitted = new Set<string>();
  dispatch(window, { type: "historyReplay", active: true } as any);
  for (const item of items) {
    const start = updates.length;
    projection.acceptHistory(item);
    for (const update of updates.slice(start)) {
      if (update.sessionUpdate === "user_message_chunk") {
        dispatch(window, { type: "userMessageChunk", text: update.content.text } as any);
        continue;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        dispatch(window, { type: "messageChunk", text: update.content.text } as any);
        continue;
      }
      dispatch(window, {
        type: update.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate",
        call: update,
      } as any);
      const replayed = commandOutputForToolCall(update, { replaying: true, rememberedCommands: remembered });
      if (!replayed) continue;
      const id = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : replayed.command;
      if (emitted.has(id)) continue;
      emitted.add(id);
      dispatch(window, { type: "commandOutput", ...replayed } as any);
    }
  }
  dispatch(window, { type: "messageChunk", text: "Turn ended" } as any);
  dispatch(window, { type: "historyReplay", active: false } as any);
}

it("keeps a resumed command's output on the run that printed it when an earlier run failed", () => {
  const h = bootWebview();
  try {
    replayMuseHistory(h.window, [
      { itemId: "fail", callId: "fail-call", kind: "toolCall", tool: "bash", revision: 1,
        status: "failed", failureReason: "exit 1",
        args: JSON.stringify({ command: "npm test" }), visibleOutput: "1 failed\n" },
      { itemId: "ask", kind: "userMessage", text: "try again", revision: 1 },
      { itemId: "ok", callId: "ok-call", kind: "toolCall", tool: "bash", revision: 1,
        status: "completed", args: JSON.stringify({ command: "npm test" }), visibleOutput: "124 passed\n" },
    ]);
    const rows = [...h.doc.querySelectorAll(".tool-flat")];
    expect(rows.map(row => ({
      error: row.querySelector(".tool-error")?.textContent ?? null,
      output: row.querySelector(".tool-cmd-output")?.textContent ?? null,
    }))).toEqual([
      { error: "exit 1", output: "1 failed\n" },
      { error: null, output: "124 passed\n" },
    ]);
  } finally { h.window.happyDOM.abort(); }
});

it("a resumed command that printed nothing still does not take the next run's output", () => {
  const h = bootWebview();
  try {
    replayMuseHistory(h.window, [
      { itemId: "fail", callId: "fail-call", kind: "toolCall", tool: "bash", revision: 1,
        status: "cancelled", args: JSON.stringify({ command: "npm test" }) },
      { itemId: "ask", kind: "userMessage", text: "try again", revision: 1 },
      { itemId: "ok", callId: "ok-call", kind: "toolCall", tool: "bash", revision: 1,
        status: "completed", args: JSON.stringify({ command: "npm test" }), visibleOutput: "124 passed\n" },
    ]);
    const rows = [...h.doc.querySelectorAll(".tool-flat")];
    expect(rows.map(row => ({
      error: row.querySelector(".tool-error")?.textContent ?? null,
      output: row.querySelector(".tool-cmd-output")?.textContent ?? null,
    }))).toEqual([
      { error: 'Muse reported "cancelled" without a reason.', output: null },
      { error: null, output: "124 passed\n" },
    ]);
  } finally { h.window.happyDOM.abort(); }
});

it("renders a Muse tool's failure reason under the row", () => {
  const h = bootWebview();
  try {
    const p = new Projection(call => dispatch(h.window, {
      type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call,
    } as any), () => {});
    const item = { itemId: "tool", kind: "toolCall", tool: "bash", revision: 1, status: "inProgress" };
    p.accept("item/started", { item });
    p.accept("item/completed", { item: { ...item, revision: 2, status: "failed",
      failureReason: "permission denied", fallbackText: "summary", visibleOutput: "ignored\n" } });
    dispatch(h.window, { type: "messageChunk", text: "Turn ended" } as any);
    expect(h.doc.querySelector(".tool-flat .tool-error")?.textContent).toBe("permission denied");
  } finally { h.window.happyDOM.abort(); }
});

it("shows a completed Muse command's output", () => {
  const h = bootWebview();
  try {
    const p = new Projection(call => dispatch(h.window, {
      type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call,
    } as any), () => {});
    const item = { itemId: "tool", callId: "call", kind: "toolCall", tool: "bash",
      args: JSON.stringify({ command: "echo hello" }) };
    p.accept("item/started", { item: { ...item, revision: 1, status: "inProgress" } });
    p.accept("item/completed", { item: { ...item, revision: 2, status: "completed", visibleOutput: "hello\n" } });
    expect(h.doc.querySelector(".tool-cmd-output")?.textContent).toBe("hello\n");
  } finally { h.window.happyDOM.abort(); }
});

it.each(["rejected", "timedOut", "futureStatus"])("renders Muse %s as terminal with its reported outcome", status => {
  const h = bootWebview();
  try {
    const p = new Projection(call => dispatch(h.window, {
      type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call,
    } as any), () => {});
    const item = { itemId: "tool", kind: "toolCall", tool: "bash", revision: 1, status: "inProgress" };
    p.accept("item/started", { item });
    p.accept("item/completed", { item: { ...item, revision: 2, status } });
    dispatch(h.window, { type: "messageChunk", text: "Turn ended" } as any);
    expect({ running: h.doc.querySelector(".tool-group.in-progress"),
      outcome: h.doc.querySelector(".tool-flat .tool-error")?.textContent })
      .toEqual({ running: null, outcome: `Muse reported "${status}" without a reason.` });
  } finally { h.window.happyDOM.abort(); }
});
