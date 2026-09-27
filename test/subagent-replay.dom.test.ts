// Replays a REAL Composer-agent wire capture through the shipped chat.js:
// test/fixtures/composer-subagent-session.jsonl holds the (trimmed) tool
// records of the "10 tool calls + 5 subagents in mixed order" demo session
// that produced the original mess — false Subagent cards from Greps titled
// with subagent-ish search patterns, and Task delegations that never complete
// on the tool channel (Composer's completion arrives ONLY via the
// subagent_spawned/subagent_finished lifecycle events).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootWebview, dispatch } from "./webview-harness";

const RECORDS = fs
  .readFileSync(path.join(__dirname, "fixtures", "composer-subagent-session.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function replayAll(window: any) {
  for (const rec of RECORDS) {
    dispatch(window, { type: rec.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call: rec });
  }
}

describe("composer-agent mixed 10-tools + 5-subagents session (real wire replay)", () => {
  it("cards exactly the 6 Task delegations — subagent-titled Greps stay in the tool groups", () => {
    const { window, doc } = bootWebview();
    replayAll(window);

    const cards = [...doc.querySelectorAll(".subagent-card")];
    expect(cards).toHaveLength(6);
    const titles = cards.map((c) => c.querySelector(".subagent-title")!.textContent);
    expect(titles).toContain("Demo subagent file count");
    expect(titles).toContain("Subagent 1: count tests");
    expect(titles).toContain("Subagent 5: docs files");
    // The Greps whose PATTERNS were subagent-ish must not have become cards.
    expect(titles).not.toContain("spawn_subagent");
    expect(titles).not.toContain("isSubagentToolCall");
    // And ordinary tools still landed in generic groups.
    expect(doc.querySelector(".tool-group")).not.toBeNull();
  });

  it("Task cards complete from the untitled completion update without losing their titles", () => {
    const { window, doc } = bootWebview();
    replayAll(window);

    // Composer's completion is a THIRD update per delegation: status completed,
    // NO _meta, title "" (must not downgrade the shown title), the output as
    // rawOutput {type:"Text", text} / content text wrapped in the CLI envelope.
    const cards = [...doc.querySelectorAll(".subagent-card")];
    expect(cards.every((c) => c.classList.contains("subagent-done"))).toBe(true);
    expect(cards.every((c) => !c.querySelector(".blink-dots"))).toBe(true);

    const first = cards[0];
    // The untitled completion update did NOT wipe the description.
    expect(first.querySelector(".subagent-title")!.textContent).toBe("Demo subagent file count");
    const body = first.querySelector(".subagent-result") as HTMLElement;
    expect(body.hidden).toBe(true); // collapsed until clicked
    expect(body.textContent).not.toContain("Output of the subagent:");
    // The CLI envelope is stripped from the child's words.
    expect(body.textContent).not.toContain("This is the output of the subagent:");
    expect(body.textContent).not.toContain("<response>");
  });

  it("a NEW live subagent's lifecycle does NOT tag/fill a RESTORED card (no cross-attribution)", () => {
    const { window, doc } = bootWebview();
    // Restore wraps replay in historyReplay so cards are marked as restored —
    // they never received their own live lifecycle (session/load strips it).
    dispatch(window, { type: "historyReplay", active: true });
    replayAll(window);
    dispatch(window, { type: "historyReplay", active: false });
    const first = doc.querySelector(".subagent-card")! as HTMLElement;
    expect(first.querySelector(".subagent-time")!.textContent).toBe("");

    // A brand-new subagent runs later. Its spawn+finish must NOT tag or fill the
    // restored card (that would stamp the NEW run's duration/output onto the OLD
    // card — the corruption bug). With no live card present, it's simply a no-op.
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "child-new" } });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_finished", subagent_id: "child-new", status: "completed", duration_ms: 7343, output: "NEW RUN OUTPUT" },
    });
    expect(first.querySelector(".subagent-time")!.textContent).toBe(""); // untouched
    expect(first.dataset.subagentId).toBeUndefined(); // never tagged by the live spawn
    expect((first.querySelector(".subagent-result") as HTMLElement).textContent || "").not.toContain("NEW RUN OUTPUT");
  });

  it("a failed subagent_finished renders the failure, not a silent empty success", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "t-fail",
        title: "Task",
        _meta: { "x.ai/tool": { name: "Task" } },
        rawInput: { description: "Do a thing", subagent_type: "generalPurpose", prompt: "x" },
      },
    });
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "cf" } });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_finished", subagent_id: "cf", status: "failed", duration_ms: 1200, error: "tool crashed" },
    });
    const card = doc.querySelector(".subagent-card")! as HTMLElement;
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.classList.contains("subagent-failed")).toBe(true);
    // Visible on the row itself (red via .subagent-failed CSS), no expand needed.
    expect((card.querySelector(".subagent-status") as HTMLElement).textContent).toBe("failed");
    expect((card.querySelector(".subagent-result") as HTMLElement).textContent).toContain("tool crashed");
  });

  it("a restored BACKGROUND delegation shows its result + duration, and drops the redundant poller row", () => {
    const { window, doc } = bootWebview();
    // Real session/load order: the spawn replays (started-ack tags the child id),
    // then the poller replays as a completed tool_call carrying the FLATTENED
    // text blob (not the live structured TaskOutput).
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "spawn-r",
        title: "spawn_subagent",
        status: "completed",
        _meta: { "x.ai/tool": { name: "spawn_subagent" } },
        rawInput: { description: "Quick subagent smoke test", subagent_type: "general-purpose", background: true },
        content: [{ content: { text: "Subagent started in background.\nsubagent_id: 019f6aa8-d3dc-70d2-bfac-785e0e5f3e03" } }],
      },
    });
    const blob = [
      "=== Task 019f6aa8-d3dc-70d2-bfac-785e0e5f3e03 ===",
      "Command: [subagent:general-purpose] Quick subagent smoke test",
      "Status: completed",
      "Duration: 18.78s",
      "",
      "=== Output ===",
      "Subagent smoke test ran successfully.",
      "",
      "<subagent_meta>id=019f6aa8, type=general-purpose, duration_ms=18778</subagent_meta>",
    ].join("\n");
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "poller-r", title: "get_command_or_subagent_output", status: "completed", rawInput: { task_ids: ["019f6aa8-d3dc-70d2-bfac-785e0e5f3e03"] }, content: [{ content: { text: blob } }] },
    });
    dispatch(window, { type: "historyReplay", active: false });

    const cards = [...doc.querySelectorAll(".subagent-card")];
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".subagent-title")!.textContent).toBe("Quick subagent smoke test");
    expect(card.querySelector(".subagent-time")!.textContent).toBe("0:18"); // 18778ms rounded
    const body = card.querySelector(".subagent-result") as HTMLElement;
    expect(body.textContent).toContain("Subagent smoke test ran successfully.");
    // The poller's own "[subagent:general-purpose] …" row must NOT appear.
    expect(doc.body.textContent || "").not.toContain("[subagent:");
    expect(doc.querySelector(".tool-group")).toBeNull();
  });

  it("a TOOL-CHANNEL failure (completion beats the lifecycle) flags the card red", () => {
    // Fable-flagged ordering: grok's completed tool_call_update carries
    // status:"failed" and lands BEFORE any lifecycle event — the failure marker
    // must still render (the earlier test only covered lifecycle-first).
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc-fail", title: "Task", _meta: { "x.ai/tool": { name: "Task" } }, rawInput: { description: "Do a thing", subagent_type: "general-purpose", prompt: "x" } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc-fail", status: "failed", rawOutput: { type: "Text", text: "it exploded" } },
    });
    const card = doc.querySelector(".subagent-card")! as HTMLElement;
    expect(card.classList.contains("subagent-failed")).toBe(true);
    expect(card.querySelector(".subagent-status")!.textContent).toBe("failed");
    expect(card.classList.contains("subagent-cancelled")).toBe(false);
  });

  it("a cancelled subagent reads muted, not red", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc-cancel", title: "Task", _meta: { "x.ai/tool": { name: "Task" } }, rawInput: { description: "Do a thing", subagent_type: "general-purpose", prompt: "x" } },
    });
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "cx" } });
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_finished", subagent_id: "cx", status: "cancelled", duration_ms: 900 } });
    const card = doc.querySelector(".subagent-card")! as HTMLElement;
    expect(card.classList.contains("subagent-cancelled")).toBe(true);
    expect(card.classList.contains("subagent-failed")).toBe(false);
    expect(card.querySelector(".subagent-status")!.textContent).toBe("stopped");
  });

  it("the lifecycle event is a completion backstop when the tool channel never completes", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "t-solo",
        title: "Task",
        _meta: { "x.ai/tool": { name: "Task" } },
        rawInput: { description: "Count things", subagent_type: "generalPurpose", prompt: "count" },
      },
    });
    const card = doc.querySelector(".subagent-card")!;
    expect(card.querySelector(".blink-dots")).toBeNull();

    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "c9" } });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_finished", subagent_id: "c9", status: "completed", duration_ms: 2100, output: "response:\n<response>\nAll counted.\n</response>" },
    });
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".blink-dots")).toBeNull();
    expect(card.querySelector(".subagent-time")!.textContent).toBe("0:02");
    const body = card.querySelector(".subagent-result") as HTMLElement;
    expect(body.textContent).toContain("All counted.");
    expect(body.textContent).not.toContain("<response>");
  });

  it("a background spawn completes from the poller's TaskOutput, not its started-ack", () => {
    // Real grok-build background shape (accredia session): spawn_subagent with
    // background:true "completes" instantly with a started-ack; the child's
    // real output arrives minutes later on the get_command_or_subagent_output
    // poller (the lifecycle events are logged by the CLI but not transmitted).
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "bg-spawn",
        title: "spawn_subagent",
        _meta: { "x.ai/tool": { name: "spawn_subagent" } },
        rawInput: { prompt: "say hi", description: "Simple subagent greeting demo", subagent_type: "general-purpose", background: true },
      },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "bg-spawn",
        title: "Simple subagent greeting demo",
        rawInput: { variant: "Task", description: "Simple subagent greeting demo", subagent_type: "general-purpose", run_in_background: true, task_id: "019f52f1" },
      },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "bg-spawn",
        status: "completed",
        title: "",
        rawOutput: { type: "Text", text: "Subagent started in background.\nsubagent_id: 019f52f1\ntype: general-purpose\n\nUse get_command_or_subagent_output with task_ids=[\"019f52f1\"] and timeout_ms to wait for results." },
      },
    });

    const card = doc.querySelector(".subagent-card")!;
    // Still running — the ack is not the result.
    expect(card.classList.contains("subagent-done")).toBe(false);
    expect(card.querySelector(".blink-dots")).toBeNull();

    // The poller (a DIFFERENT toolCallId) completes with the real output.
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "poller-1",
        status: "completed",
        title: "Get task output: 019f52f1",
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: "019f52f1",
            command: "[subagent:general-purpose] Simple subagent greeting demo",
            status: "completed",
            duration_secs: 70.472,
            output: "Hi! I'm a Grok Build subagent.\n\n<subagent_meta>id=019f52f1, type=general-purpose</subagent_meta>",
          },
        },
      },
    });
    expect(card.classList.contains("subagent-done")).toBe(true);
    expect(card.querySelector(".subagent-time")!.textContent).toBe("1:10");
    expect(card.querySelector(".subagent-result")!.textContent).toContain("Hi! I'm a Grok Build subagent.");
    expect(card.querySelector(".subagent-result")!.textContent).not.toContain("started in background");
    expect(card.querySelector(".subagent-result")!.textContent).not.toContain("subagent_meta");
  });

  it("historyReplay end settles never-completed delegation rows (no dots on restored history)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    replayAll(window);
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelectorAll(".subagent-card .blink-dots")).toHaveLength(0);
  });
});
