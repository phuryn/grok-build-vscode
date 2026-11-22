import { describe, expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { commandOutputForToolCall } from "../src/acp-dispatch";

describe("Muse raw notification projection", () => {
  it.each([
    ["assistant", "List the files"],
    ["workflow-agent", "List the files"],
    ["Inventory", "Inventory"],
  ])("uses a readable title for role %s", (role, title) => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.accept("item/started", { item: { kind: "subagent", itemId: "card", revision: 1,
      status: "inProgress", role, objective: "List the files\nReturn the count." } });
    expect(updates[0]).toMatchObject({ title, rawInput: { prompt: "List the files\nReturn the count." } });
    expect(updates[0].rawInput.description).toBeUndefined();
  });

  it.each([
    [{ result: { ref: "owner-result-ref:example", summary: "brief", text: "ok" } }, "ok"],
    [{ results: [{ summary: "first" }, { text: "second" }] }, "first\n\nsecond"],
    [{ result: { text: "notes", count: 3 } }, '````json\n{\n  "result": {\n    "text": "notes",\n    "count": 3\n  }\n}\n````'],
    [{ count: 3 }, '````json\n{\n  "count": 3\n}\n````'],
  ])("renders a workflow result %#", (value, expected) => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    const summary = JSON.stringify(value);
    p.acceptHistory({ kind: "workflow", itemId: "run", workflowRunId: "run", revision: 1, status: "completed",
      message: `<workflow-launch-reconciled>${JSON.stringify({ final_summary: { summary } })}</workflow-launch-reconciled>` });
    expect(updates[0]._meta["muse/workflow"].result_summary).toBe(expected);
  });

  it.each(["subagent_spawn", "subagent_wait", "subagent_list", "subagent_stop", "subagent_read_result", "submit_result"])(
    "suppresses %s and its streamed output", tool => {
      const updates: any[] = [];
      const p = new Projection(u => updates.push(u), () => {});
      const item = { kind: "toolCall", itemId: "tool", revision: 1, status: "inProgress", tool };
      p.accept("item/started", { item });
      p.accept("item/delta", { itemId: "tool", field: "output", delta: "working" });
      p.accept("item/completed", { item: { ...item, revision: 2, status: "completed", visibleOutput: "working" } });
      expect(updates).toEqual([]);
    });

  it.each(["subagent_send_message", "subagent_followup_task"])("keeps %s visible", tool => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.acceptHistory({ kind: "toolCall", itemId: "tool", revision: 1, status: "completed", tool });
    expect(updates[0]).toMatchObject({ title: tool, status: "completed" });
  });

  it.each([
    ["completed", "completed", false],
    ["failed", "failed", false],
    ["cancelled", "completed", true],
  ])("replays a native %s result that appears before its card", (resultStatus, status, cancelled) => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.stopSubagents = true;
    p.acceptHistory({ kind: "subagentResult", itemId: "result", subagentId: "worker", revision: 1,
      status: "completed", resultStatus, text: "Outcome." });
    p.acceptHistory({ kind: "subagent", itemId: "card", subagentId: "worker", revision: 2,
      status: "inProgress" });
    expect(updates).toMatchObject([{ status, rawOutput: { output: "Outcome." },
      _meta: { "muse/cancelled": cancelled, "muse/canStop": false } }]);
  });

  it("appends live text and authoritative suffixes without duplicating or rewriting a prefix", () => {
    const updates: any[] = [], logs: string[] = [];
    const projection = new Projection(u => updates.push(u), m => logs.push(m));
    const revision = (revision: number, text: string) => projection.accept("item/updated", {
      item: { itemId: "answer", kind: "agentMessage", revision, text },
    });
    revision(1, "");
    projection.accept("item/delta", { itemId: "answer", field: "text", delta: "Hello" });
    projection.accept("item/delta", { itemId: "answer", field: "text", delta: " world" });
    revision(2, "Hello world");
    revision(2, "Hello world");
    revision(1, "STALE");
    revision(3, "Hello");
    revision(4, "Changed prefix");
    revision(5, "Hello world!");
    expect(updates.map(u => u.content.text)).toEqual(["Hello", " world", "!"]);
    expect(logs).toEqual(["Muse projection: prefix-changing text revision for item answer"]);
  });

  // #207: Muse's reasoning summary was dropped, so "Show thinking traces" never
  // showed it. Measured live 2026-10-16: item/started reasoning, then
  // item/delta on fields summary.0 and summary.1, then item/completed with the
  // parts in `summary`.
  it("streams a reasoning summary as thinking, one part per paragraph, without repeating it on completion", () => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.accept("item/started", { item: { itemId: "r", kind: "reasoning", revision: 1, summary: [] } });
    p.accept("item/delta", { itemId: "r", field: "summary.0", delta: "Framing the plan" });
    p.accept("item/delta", { itemId: "r", field: "summary.0", delta: " first." });
    p.accept("item/delta", { itemId: "r", field: "summary.1", delta: "Then the reply." });
    p.accept("item/completed", { item: { itemId: "r", kind: "reasoning", revision: 2, summary: ["Framing the plan first.", "Then the reply."] } });
    expect(updates.every(u => u.sessionUpdate === "agent_thought_chunk")).toBe(true);
    expect(updates.map(u => u.content.text).join("")).toBe("Framing the plan first.\n\nThen the reply.");
  });

  // Measured live 2026-10-16: "…ruling out image handling.Analyzing a conflict…"
  // The renderer keeps one thinking block per turn whatever comes in between,
  // so every new reasoning item opens a paragraph, after other output too
  // (review 4.15.1: a tool call between two items still ran them together).
  it("starts a new paragraph for every new reasoning item", () => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.accept("item/delta", { itemId: "r1", field: "summary.0", delta: "First thought." });
    p.accept("item/delta", { itemId: "r1", field: "summary.0", delta: " More." });
    p.accept("item/delta", { itemId: "r2", field: "summary.0", delta: "Second thought." });
    p.accept("item/delta", { itemId: "a", field: "text", delta: "Answer." });
    p.accept("item/delta", { itemId: "r3", field: "summary.0", delta: "Later thought." });
    const thinking = updates.filter(u => u.sessionUpdate === "agent_thought_chunk").map(u => u.content.text);
    expect(thinking).toEqual(["First thought.", " More.", "\n\nSecond thought.", "\n\nLater thought."]);
  });

  it("replays a reasoning item from history as thinking", () => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.acceptHistory({ itemId: "r", kind: "reasoning", revision: 3, summary: ["One.", "Two."] });
    expect(updates).toEqual([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "One.\n\nTwo." } }]);
  });

  it.each(["inProgress", "completed", "failed", "cancelled", "rejected", "timedOut", "aborted", "futureStatus"])(
    "projects live and replayed tool status %s using the open terminal contract", status => {
      for (const history of [false, true]) {
        const updates: any[] = [];
        const p = new Projection(u => updates.push(u), () => {});
        const item = { itemId: "tool", kind: "toolCall", tool: "bash", revision: 2, status };
        if (history) p.acceptHistory(item);
        else {
          p.accept("item/started", { item: { ...item, revision: 1, status: "inProgress" } });
          p.accept("item/updated", { item });
        }
        const expected = status === "inProgress" ? "in_progress" : status === "completed" ? "completed" : "failed";
        expect(updates.at(-1)).toMatchObject({ status: expected,
          rawOutput: expected === "failed"
            ? { message: `Muse reported "${status}" without a reason.`, output: "" }
            : undefined });
      }
    });

  it.each([false, true])("prefers a reported failure reason over summary, output, then a bare status (history=%s)", history => {
    const output = ["one", "two", "", "  ", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n");
    const cases: { extra: Record<string, unknown>; message: string; status?: string }[] = [
      { extra: { failureReason: " permission denied ", fallbackText: "summary", visibleOutput: output }, message: "permission denied" },
      { extra: { failureReason: "  ", fallbackText: " summary ", visibleOutput: output }, message: "summary" },
      { extra: { fallbackText: "\n", visibleOutput: output }, message: ["three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n") },
      { extra: { visibleOutput: "\n  \n" }, message: 'Muse reported "failed" without a reason.' },
      { extra: {}, status: "rejected", message: 'Muse reported "rejected" without a reason.' },
    ];
    for (const { extra, message, status = "failed" } of cases) {
      const updates: any[] = [];
      const p = new Projection(u => updates.push(u), () => {});
      const item = { itemId: "tool", kind: "toolCall", tool: "bash", revision: 2, status, ...extra };
      if (history) p.acceptHistory(item);
      else {
        p.accept("item/started", { item: { ...item, revision: 1, status: "inProgress", failureReason: undefined, fallbackText: undefined, visibleOutput: undefined } });
        p.accept("item/completed", { item });
      }
      const failed = updates.filter(u => u.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].rawOutput).toEqual({
        message,
        output: typeof extra.visibleOutput === "string" ? extra.visibleOutput : "",
      });
    }
  });

  it.each([
    ['{"command":"echo example","timeout":123}', { command: "echo example", timeout: 123 }],
    ['{"cmd":"echo alias"}', { cmd: "echo alias" }],
    ['{"path":"example.txt"}', { path: "example.txt" }],
    ["{}", {}], [undefined, undefined], ["", undefined], ["{invalid", undefined],
    ["null", undefined], ["[]", undefined], ['"echo not an object"', undefined], ["42", undefined],
  ])("projects argument JSON %s safely as an object", (args, expected) => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.accept("item/started", { item: { itemId: "tool", kind: "toolCall", tool: "bash", revision: 1, status: "inProgress", args } });
    expect(updates[0].rawInput).toEqual(expected);
  });

  it.each([["bash", "execute"], ["powershell", "execute"], ["search", "search"], ["read", "other"], ["hasOwnProperty", "other"]])(
    "gives Muse's %s tool the %s kind", (tool, kind) => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.accept("item/started", { item: { itemId: "tool", kind: "toolCall", tool, revision: 1, status: "inProgress" } });
    expect(updates[0]).toMatchObject({ title: tool, kind });
  });

  it("projects tool output snapshots and consumes reminder lifecycle without answer text", () => {
    const updates: any[] = [], logs: string[] = [];
    const p = new Projection(u => updates.push(u), m => logs.push(m));
    p.accept("item/started", { item: { itemId: "tool", callId: "call", kind: "toolCall",
      revision: 1, tool: "bash", args: JSON.stringify({ command: "example" }), status: "inProgress" } });
    for (const delta of ["one", " two"]) p.accept("item/delta", { itemId: "tool", field: "output", delta });
    p.accept("item/completed", { item: { itemId: "tool", callId: "call", kind: "toolCall",
      revision: 2, tool: "bash", status: "completed", visibleOutput: "one two" } });
    p.accept("item/started", { item: { itemId: "reminder", kind: "reminderChild", revision: 1, text: "hidden" } });
    p.accept("item/delta", { itemId: "reminder", field: "text", delta: "hidden delta" });
    p.accept("item/completed", { item: { itemId: "reminder", kind: "reminderChild", revision: 2, text: "hidden final" } });
    expect(updates.filter(u => u.sessionUpdate === "agent_message_chunk")).toEqual([]);
    expect(updates.filter(u => u.content).map(u => u.content[0].content.text)).toEqual(["one", "one two", "one two"]);
    expect(updates.at(-1)).toMatchObject({ toolCallId: "call", status: "completed",
      rawOutput: { output: "one two" },
      content: [{ type: "content", content: { type: "text", text: "one two" } }] });
    expect(logs).toEqual([]);
  });

  it("carries a resumed command's output where replay reads it", () => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    p.acceptHistory({ itemId: "tool", callId: "call", kind: "toolCall", tool: "bash", revision: 1,
      status: "completed", args: JSON.stringify({ command: "echo hello" }), visibleOutput: "hello\n" });
    const call = updates.find(u => u.status === "completed");
    expect(call).toMatchObject({
      rawOutput: { output: "hello\n" },
      content: [{ type: "content", content: { type: "text", text: "hello\n" } }],
    });
    expect(commandOutputForToolCall(call, { replaying: true })).toMatchObject({
      command: "echo hello", output: "hello\n", cancelled: false,
    });
    expect(commandOutputForToolCall(call, { replaying: false })).toBeNull();
  });

  it("a failed or cancelled resumed command yields its own replay output and keeps its reason", () => {
    const project = (item: Record<string, unknown>) => {
      const updates: any[] = [];
      new Projection(u => updates.push(u), () => {}).acceptHistory(item);
      return updates.find(u => u.status === "failed");
    };
    const failed = project({
      itemId: "fail", callId: "fail", kind: "toolCall", tool: "bash", revision: 1, status: "failed",
      failureReason: "exit 1", args: JSON.stringify({ command: "npm test" }), visibleOutput: "1 failed\n",
    });
    expect(failed.rawOutput.message).toBe("exit 1");
    expect(commandOutputForToolCall(failed, { replaying: true })).toEqual({
      command: "npm test", output: "1 failed\n", exitCode: null, truncated: false, cancelled: false, agentSawCut: true,
    });
    expect(commandOutputForToolCall(failed, { replaying: false })).toBeNull();

    const cancelled = project({
      itemId: "stop", callId: "stop", kind: "toolCall", tool: "bash", revision: 1, status: "cancelled",
      args: JSON.stringify({ command: "npm test" }),
    });
    expect(cancelled.rawOutput.message).toBe('Muse reported "cancelled" without a reason.');
    expect(commandOutputForToolCall(cancelled, { replaying: true })).toEqual({
      command: "npm test", output: "", exitCode: null, truncated: false, cancelled: false, agentSawCut: true,
    });
  });
});
