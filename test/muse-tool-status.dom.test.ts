import { expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, dispatch } from "./webview-harness";

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
