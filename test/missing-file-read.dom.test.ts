import { describe, expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, click, dispatch } from "./webview-harness";

// Envelopes checked in the installed adapters and repository captures; see
// research/missing-file-reads.md. These tests never launch a provider.
const textContent = (text: string) => [{ type: "content", content: { type: "text", text } }];
const shapes = [
  { provider: "muse", start: { kind: "read", title: "Read test2.md", rawInput: { path: "test2.md" } },
    failure: (message: string) => ({ rawOutput: { error: "tool_execution_failed", message }, content: textContent(message) }),
    message: "No such file or directory (os error 2); requested relative path test2.md" },
  { provider: "grok", start: { title: "read_file", rawInput: { target_file: "test2.md" } },
    failure: (message: string) => ({ rawOutput: { type: "ReadFile", FileReadError: message } }),
    message: "ENOENT: no such file or directory, open 'test2.md'" },
  { provider: "claude", start: { kind: "read", title: "Read File", rawInput: {} },
    failure: (message: string) => ({ title: "Read test2.md", rawInput: { file_path: "test2.md" }, content: textContent(message) }),
    message: "File does not exist." },
  { provider: "codex", start: { kind: "read", title: "Read file 'test2.md'", locations: [{ path: "test2.md" }] },
    failure: (message: string) => ({ rawOutput: { formatted_output: message, exit_code: 1 } }),
    message: "cat: test2.md: No such file or directory" },
];

describe.each(shapes)("missing file read: $provider", shape => {
  it.each(["live", "replay", "late"].flatMap(ordering =>
    [{}, { vscode: true }, { remote: true }].map(surface => ({ ordering, surface }))))(
    "is neutral, labelled, and expandable on $ordering, $surface", ({ ordering, surface }) => {
    const h = bootWebview(surface);
    try {
      const initial = { toolCallId: "read", ...shape.start };
      const failed = { toolCallId: "read", status: "failed", ...shape.failure(shape.message) };
      if (ordering === "replay") dispatch(h.window, { type: "toolCall", call: { ...initial, ...failed } } as any);
      else {
        dispatch(h.window, { type: "toolCall", call: initial } as any);
        if (ordering === "late") dispatch(h.window, { type: "messageChunk", text: "Checking" } as any);
        dispatch(h.window, { type: "toolCallUpdate", call: failed } as any);
      }
      dispatch(h.window, { type: "messageChunk", text: "Created test2.md" } as any);
      const row = h.doc.querySelector(".tool-flat")!;
      expect(row.querySelector(".tool-label")?.textContent).toBe("test2.md — doesn't exist yet");
      expect(h.doc.querySelector(".tool-failed, .has-error, .cmd-out-marker.error, .tool-error")).toBeNull();
      const detail = row.querySelector(".tool-item-details") as HTMLElement;
      expect(detail.hidden).toBe(true);
      click(h.window, row);
      expect(detail.hidden).toBe(false);
      expect(detail.textContent).toBe(shape.message);
    } finally { h.window.happyDOM.abort(); }
  });

  it.each(["Permission denied (os error 13)", "EIO: I/O error", "No such file or directory; permission denied reading another file"])("keeps %s red", message => {
    const h = bootWebview();
    try {
      dispatch(h.window, { type: "toolCall", call: { toolCallId: "read", ...shape.start } } as any);
      dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "read", status: "failed", ...shape.failure(message) } } as any);
      expect(h.doc.querySelector(".tool-item.tool-failed .tool-error")?.textContent).toBe(message);
      expect(h.doc.querySelector(".tool-group.has-error")).not.toBeNull();
    } finally { h.window.happyDOM.abort(); }
  });
});

it("projects Muse's missing-file failure into a neutral row inside a mixed tool group", () => {
  const h = bootWebview();
  try {
    const p = new Projection(call => dispatch(h.window, {
      type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call,
    } as any), () => {});
    p.acceptHistory({ itemId: "read", kind: "toolCall", tool: "read_file", revision: 1,
      args: JSON.stringify({ path: "test2.md" }), status: "failed", failureReason: shapes[0].message });
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "write", kind: "edit", title: "Created test2.md" } } as any);
    dispatch(h.window, { type: "messageChunk", text: "Created" } as any);
    expect(h.doc.querySelector(".tool-item-label")?.textContent).toBe("test2.md — doesn't exist yet");
    expect(h.doc.querySelector(".tool-failed, .has-error")).toBeNull();
  } finally { h.window.happyDOM.abort(); }
});

it.each(["execute", "edit", "search", "fetch"])("does not neutralize a missing-file %s failure", kind => {
  const h = bootWebview();
  try {
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "other", kind, title: "Other tool", status: "failed",
      content: textContent("No such file or directory (os error 2)") } } as any);
    expect(h.doc.querySelector(".tool-item.tool-failed")).not.toBeNull();
  } finally { h.window.happyDOM.abort(); }
});

it.each(["view_file", "View test2.md"])("recognizes a missing-file %s view", title => {
  const h = bootWebview();
  try {
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "view", title, rawInput: { path: "test2.md" },
      status: "failed", content: textContent("No such file or directory (os error 2)") } } as any);
    dispatch(h.window, { type: "messageChunk", text: "Done" } as any);
    expect(h.doc.querySelector(".tool-flat .tool-label")?.textContent).toBe("test2.md — doesn't exist yet");
    expect(h.doc.querySelector(".tool-failed")).toBeNull();
  } finally { h.window.happyDOM.abort(); }
});

it("does not classify successful file contents or a generic not-found error as a missing read", () => {
  const h = bootWebview();
  try {
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "ok", kind: "read", title: "Read test2.md",
      status: "completed", content: textContent("File does not exist.") } } as any);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "bad", kind: "read", title: "Read test3.md",
      status: "failed", content: textContent("Reader plugin not found") } } as any);
    expect(h.doc.querySelector(".tool-missing-message")).toBeNull();
    expect(h.doc.querySelectorAll(".tool-failed")).toHaveLength(1);
  } finally { h.window.happyDOM.abort(); }
});
