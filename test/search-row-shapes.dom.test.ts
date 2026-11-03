import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const shapes = JSON.parse(readFileSync(new URL("./fixtures/search-row-shapes.json", import.meta.url), "utf8"));

// Mirror the completed shape carried by session/load, including accumulated input.
function completed(shape: any) {
  const call = structuredClone(shape.initial);
  for (const update of shape.updates) {
    for (const [key, value] of Object.entries(update)) {
      if (value == null) continue;
      if (["rawInput", "input", "_meta"].includes(key)) {
        const previous = call[key];
        call[key] = { ...previous, ...(value as object) };
        if (key === "_meta" && (value as any)["x.ai/tool"]) {
          call[key]["x.ai/tool"] = { ...previous?.["x.ai/tool"], ...(value as any)["x.ai/tool"] };
        }
      } else call[key] = value;
    }
  }
  return call;
}

describe.each(shapes)("#229: $name", (shape) => {
  it("names the live header and settled row, preserving the rollup", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "initialState", cwd: "/repo" });
    dispatch(window, { type: "toolCall", call: shape.initial });
    expect(doc.querySelector(".tool-group-label")?.textContent?.trim()).toBe(shape.running);
    for (const call of shape.updates) dispatch(window, { type: "toolCallUpdate", call });
    expect(doc.querySelector(".tool-group-label")?.textContent?.trim()).toBe(shape.updated);
    dispatch(window, { type: "messageChunk", text: "done" });
    expect(doc.querySelector(".tool-label")?.textContent?.trim()).toBe(shape.label);
  });

  it("labels the completed replay shape identically", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "initialState", cwd: "/repo" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "toolCall", call: completed(shape) });
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".tool-label")?.textContent?.trim()).toBe(shape.label);
  });

  it.each([false, true])("keeps child targets with replay=%s", (replay) => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "initialState", cwd: "/repo" });
    if (replay) dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "toolCall", call: { toolCallId: "spawn", title: "spawn_subagent",
      _meta: { "x.ai/tool": { name: "spawn_subagent" } }, rawInput: { description: "Explore", subagent_type: "explore" } } });
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "child", child_session_id: "child" } });
    const child = (event: string, call: any) => dispatch(window, { type: "childStream", childSessionId: "child", event, call });
    if (replay) child("toolCall", completed(shape));
    else {
      child("toolCall", shape.initial);
      for (const call of shape.updates) child("toolCallUpdate", call);
    }
    if (replay) dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".subagent-tool")?.textContent?.trim()).toBe(shape.label);
  });

  it("preserves the rollup wording for a group", () => {
    const { window, doc } = bootWebview();
    const call = completed(shape);
    dispatch(window, { type: "toolCall", call });
    dispatch(window, { type: "toolCall", call: { ...call, toolCallId: `${call.toolCallId}-second` } });
    dispatch(window, { type: "messageChunk", text: "done" });
    const summary = shape.summary.replace("1 item", "2 items").replace("1 command", "2 commands");
    expect(doc.querySelector(".tool-group-label")?.textContent?.trim()).toBe(summary);
  });
});

it("takes explicit pattern keys before nested input, output or a Codex title", () => {
  const { window, doc } = bootWebview();
  dispatch(window, { type: "toolCall", call: { toolCallId: "priority", kind: "search", title: "Search for 'title' in src",
    rawInput: { pattern: "first", action: { query: "second" } }, rawOutput: { action: { query: "third" } } } });
  expect(doc.querySelector(".tool-group-label")?.textContent).toContain('Searching for "first"');
});

it("does not scrape arbitrary input or treat an unknown title as a search target", () => {
  const { window, doc } = bootWebview();
  dispatch(window, { type: "toolCall", call: { toolCallId: "unknown", kind: "search", title: "opaque tool title",
    rawInput: { arbitrary: "raw|regex" } } });
  expect(doc.querySelector(".tool-group-label")?.textContent?.trim()).toBe("Searching");
  dispatch(window, { type: "messageChunk", text: "done" });
  expect(doc.querySelector(".tool-label")?.textContent?.trim()).toBe("Search");
});

it("keeps a known grep for web_search a file search when Grok renames the title", () => {
  const { window, doc } = bootWebview();
  const call = { toolCallId: "grep-web", title: "web_search", kind: "search",
    rawInput: { pattern: "web_search", path: "src" }, _meta: { "x.ai/tool": { name: "grep" } } };
  dispatch(window, { type: "toolCall", call });
  expect(doc.querySelector(".tool-group-label")?.textContent?.trim()).toBe('Searching for "web_search" in src');
  dispatch(window, { type: "messageChunk", text: "done" });
  expect(doc.querySelector(".tool-label")?.textContent?.trim()).toBe("Search web_search in src");
});
