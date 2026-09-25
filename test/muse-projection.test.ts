import { describe, expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { commandOutputForToolCall } from "../src/acp-dispatch";

describe("Muse raw notification projection", () => {
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
          rawOutput: expected === "failed" ? { message: `Muse reported "${status}" without a reason.` } : undefined });
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
      expect(failed[0].rawOutput).toEqual({ message });
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
});
