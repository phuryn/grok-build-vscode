import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function defaultHarness(remote = false) {
  const h = bootWebview({ remote });
  dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: true }] });
  dispatch(h.window, { type: "session", sessionId: "s", provider: "deepseek", models: [] });
  dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"], deepseekHarness: "default" });
  return h;
}

describe("dsh generic ACP tools", () => {
  it("preserves Antigravity's fetch approval title", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "agy", provider: "agy", models: [] });
    dispatch(h.window, { type: "permissionRequest", req: { id: 0, toolCall: {
      toolCallId: "fetch", title: "Run read_url_content?", kind: "fetch", rawInput: { url: "https://example.com/page" },
    }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
    expect(h.doc.querySelector(".permission .card-title")!.textContent).toBe("Run read_url_content?");
  });

  it("shows the full pwsh command in a Default approval, including its arguments", () => {
    const h = defaultHarness();
    const command = 'Set-Content -LiteralPath "C:/work/config.json" -Value "changed"';
    dispatch(h.window, { type: "permissionRequest", req: { id: 1, toolCall: { toolCallId: "shell", title: "pwsh", kind: "other", rawInput: { command } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
    expect(h.doc.querySelector(".permission .card-title")!.textContent).toContain(command);
    expect(h.doc.querySelector(".permission .card-title")!.textContent).not.toBe("pwsh");
  });
  it.each(["write", "edit"])("shows the %s target and a diff supplied with the approval itself", title => {
    const h = defaultHarness();
    const path = "C:/work/config.json";
    dispatch(h.window, { type: "permissionRequest", req: { id: 2, toolCall: { toolCallId: "file", title, kind: "other", rawInput: { file_path: path }, content: [{ type: "diff", path, oldText: "old", newText: "new" }] }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
    expect(h.doc.querySelector(".permission .card-title")!.textContent).toBe(`${title === "write" ? "Write" : "Edit"} ${path}`);
    expect(h.doc.querySelector(".permission .card-subtitle")!.textContent).toContain(path);
    click(h.window, h.doc.querySelector(".permission .preview-link"));
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "openDiff", path, oldText: "old", newText: "new" }));
  });
  it("lets a phone inspect a permission diff even without a preceding tool row", () => {
    const h = defaultHarness(true);
    dispatch(h.window, { type: "permissionRequest", req: { id: 3, toolCall: { toolCallId: "file", title: "write", kind: "other", rawInput: { file_path: "/work/a.txt" }, content: [{ type: "diff", path: "/work/a.txt", oldText: "before", newText: "after" }] }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
    click(h.window, h.doc.querySelector(".permission .preview-link"));
    expect(h.doc.querySelector(".preview-overlay")!.textContent).toContain("before");
    expect(h.doc.querySelector(".preview-overlay")!.textContent).toContain("after");
    expect(h.posted.some(m => m.type === "openDiff")).toBe(false);
  });
  it.each(["default", "minimal"])("renders pwsh as a command with its output (%s)", harness => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "deepseek", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "deepseek", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: [], deepseekHarness: harness });
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "shell", title: "pwsh", kind: "other", status: "in_progress", rawInput: { command: "echo 42", description: "Print 42" } } });
    expect(h.doc.body.textContent).not.toContain("Running pwsh");
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "shell", status: "completed", content: [{ type: "content", content: { type: "text", text: "42" } }] } });
    dispatch(h.window, { type: "messageChunk", text: "done" });
    expect(h.doc.querySelector(".tool-label, .tool-item-label")!.textContent).toBe("Run echo 42");
    click(h.window, h.doc.querySelector(".has-details"));
    expect(h.doc.querySelector(".tool-cmd")!.textContent).toBe("echo 42");
    expect(h.doc.querySelector(".tool-cmd-output")!.textContent).toBe("42");
  });
  it.each([
    ["read", { file_path: "/work/a.ts" }, "Read a.ts"],
    ["edit", { file_path: "/work/a.ts", old_string: "old", new_string: "new" }, "Edit a.ts"],
    ["write", { file_path: "/work/a.ts", content: "new" }, "Write a.ts"],
    ["grep", { pattern: "needle", path: "." }, "Search needle"],
    ["glob", { pattern: "*.ts" }, "Search *.ts"],
    ["web_search", { query: "ACP protocol" }, "Web search ACP protocol"],
    ["todo_write", { todos: [{ content: "Check tests", status: "pending" }] }, "Update 1 task"],
  ])("labels %s from title and rawInput when kind is other", (title, rawInput, label) => {
    const h = bootWebview();
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "tool", title, kind: "other", status: "completed", rawInput } });
    dispatch(h.window, { type: "messageChunk", text: "done" });
    expect(h.doc.querySelector(".tool-label, .tool-item-label")!.textContent).toBe(label);
  });
  it("uses the existing subagent card and the supplied task description", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "child", title: "subagent", kind: "other", status: "in_progress", rawInput: { description: "Check the parser", prompt: "Read parser.ts" } } });
    expect(h.doc.querySelector(".subagent-title")!.textContent).toBe("Check the parser");
  });
  it.each([false, true])("shows a DeepSeek launch receipt as in background, with an explanation (remote=%s)", remote => {
    const h = defaultHarness(remote);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "child", title: "subagent", kind: "other", status: "in_progress", rawInput: { description: "Read-only project state summary" } } });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "child", status: "completed", content: [{ type: "content", content: { type: "text", text: "started subagent 591754ec-37cd-43bb-b462-a49335e2f470" } }] } });
    dispatch(h.window, { type: "agentEnd" }); // Parent completion is not child completion.
    const card = h.doc.querySelector(".subagent-card")!;
    expect(card.classList.contains("subagent-done")).toBe(false);
    // dsh's child reports to the parent agent, never on this card: no spinner,
    // no timer, no invented finish.
    expect(card.querySelector(".subagent-status")!.textContent).toBe("in background");
    expect((card.querySelector(".subagent-time") as HTMLElement).hidden).toBe(true);
    expect(card.querySelector(".subagent-title")!.textContent).toBe("Read-only project state summary");
    click(h.window, card.querySelector(".subagent-row"));
    expect(card.querySelector(".subagent-stream")!.textContent).toContain("Subagent started. DeepSeek doesn't show its work here; the main agent receives its result.");
    expect(card.querySelector(".subagent-result")!.textContent).toBe("");
  });
  it("still shows an actual DeepSeek launch failure", () => {
    const h = defaultHarness();
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "child", title: "subagent", status: "in_progress", rawInput: { description: "Read the project" } } });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "child", status: "failed", content: [{ type: "content", content: { type: "text", text: "Could not start subagent" } }] } });
    const card = h.doc.querySelector(".subagent-card")!;
    expect(card.querySelector(".subagent-status")!.textContent).toBe("failed");
    expect(card.querySelector(".subagent-result")!.textContent).toContain("Could not start subagent");
  });
  it("preserves another provider's completion even if its result resembles the dsh receipt", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", sessionId: "grok", provider: "grok", models: [] });
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "child", title: "subagent", status: "completed", rawOutput: { text: "started subagent 591754ec-37cd-43bb-b462-a49335e2f470" } } });
    expect(h.doc.querySelector(".subagent-card")!.classList.contains("subagent-done")).toBe(true);
    expect(h.doc.querySelector(".subagent-result")!.textContent).toContain("started subagent");
  });
});
