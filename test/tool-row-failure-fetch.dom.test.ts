// A failed command keeps its output behind the row's chevron, a web fetch reads
// "Fetch", and Grok's media tools (also kind "fetch") still read "Generate".
import { describe, it, expect } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const tc = (call: any) => ({ type: "toolCall", call });
const close = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" } as any);
function labels(doc: Document): string[] {
  return [...doc.querySelectorAll(".tool-item-label, .tool-flat .tool-label")].map((el) => el.textContent ?? "");
}

const HELP = [
  "```",
  "Exit code 1",
  "Run commands within a Codex-provided sandbox",
  "",
  "Usage: codex sandbox [OPTIONS] [COMMAND]...",
  "",
  "Options:",
  "  -c, --config <key=value>",
  "```",
].join("\n");

function claudeSession(window: Window) {
  dispatch(window, { type: "providerState", providers: [{ id: "claude", connected: true }] } as any);
  dispatch(window, { type: "session", sessionId: "c", provider: "claude", models: [] } as any);
}

describe("a failed command's output stays behind the chevron", () => {
  it("shows a two-line reason under the row and the full output in OUT", () => {
    const { window, doc } = bootWebview();
    claudeSession(window);
    dispatch(window, tc({ toolCallId: "sb", kind: "execute", title: "Run codex sandbox", status: "in_progress", rawInput: { command: "codex sandbox -P x -- cmd" } }));
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "sb", status: "failed", content: [{ type: "content", content: { type: "text", text: HELP } }] } } as any);
    close(window);
    const reason = doc.querySelector(".tool-error")!.textContent!;
    expect(reason).toBe("Exit code 1\nRun commands within a Codex-provided sandbox …");
    expect(reason).not.toContain("Usage:");
    expect(doc.querySelector(".tool-failed")).not.toBeNull();
    click(window, doc.querySelector(".has-details"));
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toContain("Usage: codex sandbox");
  });

  it("keeps a plain tool's whole failure text when it has no OUT box", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "v", kind: "other", title: "image_to_video", status: "in_progress" }));
    const msg = "Tool `image_to_video` failed: image reference not readable\nsecond line\nthird line";
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "v", status: "failed", rawOutput: { message: msg } } } as any);
    close(window);
    expect(doc.querySelector(".tool-error")!.textContent).toBe(msg);
  });
});

describe("fetch-kind rows", () => {
  it("labels a web fetch Fetch, not Generate", () => {
    const { window, doc } = bootWebview();
    claudeSession(window);
    dispatch(window, tc({ toolCallId: "f", kind: "fetch", title: "Fetch", status: "completed", rawInput: { url: "https://code.claude.com/docs/en/sandboxing", prompt: "What does it say?" } }));
    close(window);
    expect(labels(doc).join("|")).toContain("Fetch code.claude.com/docs/en/sandboxing");
    expect(doc.body.textContent).not.toContain("Generate");
  });

  it("keeps Generate for Grok's image tool", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "g", kind: "fetch", title: "imagine: a red bicycle", status: "completed", rawInput: { prompt: "a red bicycle" } }));
    close(window);
    expect(labels(doc).join("|")).toMatch(/^Generate/);
  });
});

// Claude sends WebSearch and WebFetch as kind "fetch" and names the tool in
// _meta; Codex sends web page actions as kind "search" titled "Open page: …".
describe("web rows from Claude and Codex", () => {
  function summary(doc: Document): string {
    return [...doc.querySelectorAll(".tool-group-summary, .tool-summary, summary")].map((el) => el.textContent ?? "").join("|");
  }

  it("labels Claude's WebSearch a web search and counts both as web", () => {
    const { window, doc } = bootWebview();
    claudeSession(window);
    dispatch(window, tc({ toolCallId: "w1", kind: "fetch", title: 'Search "afk pilot"', status: "completed",
      rawInput: { query: "afk pilot" }, _meta: { claudeCode: { toolName: "WebSearch" } } }));
    dispatch(window, tc({ toolCallId: "w2", kind: "fetch", title: "Fetch https://example.com/a", status: "completed",
      rawInput: { url: "https://example.com/a" }, _meta: { claudeCode: { toolName: "WebFetch" } } }));
    close(window);
    expect(labels(doc).join("|")).toContain("Web search afk pilot");
    expect(doc.body.textContent).not.toMatch(/generat/i);
  });

  it("shows Codex's Open page and Find in page titles and counts them as web", () => {
    const { window, doc } = bootWebview();
    dispatch(window, tc({ toolCallId: "o1", kind: "search", title: "Open page: https://example.com/docs", status: "completed" }));
    dispatch(window, tc({ toolCallId: "o2", kind: "search", title: "Find in page for 'install' in https://example.com/docs", status: "completed" }));
    close(window);
    const text = labels(doc).join("|");
    expect(text).toContain("Open page: https://example.com/docs");
    expect(text).toContain("Find in page for 'instal");
    expect(summary(doc) + doc.body.textContent).not.toMatch(/explored/i);
  });
});

describe("a new chat's context window", () => {
  it("does not keep the previous chat's window when its model names none", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "a", provider: "grok", currentModelId: "g",
      models: [{ provider: "grok", modelId: "g", name: "Big", totalContextTokens: 1000000 }] } as any);
    expect(doc.getElementById("donut-label")!.textContent).toMatch(/\/1M$/);
    dispatch(window, { type: "session", sessionId: "b", provider: "codex", currentModelId: "c",
      models: [{ provider: "codex", modelId: "c", name: "Codex" }] } as any);
    expect(doc.getElementById("donut-label")!.textContent).toMatch(/\/200K$/);
  });
});
