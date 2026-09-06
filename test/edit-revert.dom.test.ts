// DOM-level tests for "revert edit ↶" (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 5),
// driving the REAL shipped media/chat.js in a happy-dom window.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };

describe("revert edit ↶", () => {
  it("is offered only once the edit is completed, and posts the diff payload back", () => {
    const { window, doc, posted } = bootWebview();

    dispatch(window, { type: "toolCall", call: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" } });
    // In-progress: no revert button yet — the write hasn't landed on disk.
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", status: "in_progress", content: [DIFF] } });
    expect(doc.querySelector(".revert-link")).toBeNull();

    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", status: "completed", content: [DIFF] } });
    const button = doc.querySelector(".revert-link") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("revert edit");
    expect(button.disabled).toBe(false);

    click(window, button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("reverting");
    const sent = posted.filter((m: any) => m.type === "revertToolEdit");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      toolCallId: "tc1",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
    });
  });

  it("flips to 'reverted' and stays disabled on a successful host ack", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "tc2", kind: "edit", title: "Edit" } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc2", status: "completed", content: [DIFF] } });
    const button = doc.querySelector(".revert-link") as HTMLButtonElement;
    click(window, button);

    dispatch(window, { type: "toolEditReverted", toolCallId: "tc2", path: "src/foo.ts", ok: true });
    expect(button.textContent).toBe("reverted");
    expect(button.disabled).toBe(true);

    // Clicking again does nothing further — onclick was cleared.
    click(window, button);
  });

  it("restores the clickable label on a failed host ack, so the user can retry", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "tc3", kind: "edit", title: "Edit" } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc3", status: "completed", content: [DIFF] } });
    const button = doc.querySelector(".revert-link") as HTMLButtonElement;
    click(window, button);

    dispatch(window, {
      type: "toolEditReverted",
      toolCallId: "tc3",
      path: "src/foo.ts",
      ok: false,
      reason: "The file has changed since this edit and can't be safely reverted.",
    });
    expect(button.textContent).toContain("revert edit");
    expect(button.disabled).toBe(false);

    click(window, button);
    const sent = posted.filter((m: any) => m.type === "revertToolEdit");
    expect(sent).toHaveLength(2); // retried
  });

  it("a create diff (empty oldText) is still revertible once completed", () => {
    const { window, doc, posted } = bootWebview();
    const create = { type: "diff", path: "src/new.ts", oldText: "", newText: "hello\n" };
    dispatch(window, { type: "toolCall", call: { toolCallId: "tc4", kind: "edit", title: "Create src/new.ts" } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc4", status: "completed", content: [create] } });
    const button = doc.querySelector(".revert-link") as HTMLButtonElement;
    expect(button).not.toBeNull();
    click(window, button);
    expect(posted.filter((m: any) => m.type === "revertToolEdit")[0]).toMatchObject({
      path: "src/new.ts",
      oldText: "",
      newText: "hello\n",
    });
  });

  it("renders revert edit when toolCallUpdate is completed without repeating content (Claude lifecycle)", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc5", kind: "edit", title: "Edit src/foo.ts", content: [DIFF] },
    });
    // While still in-progress/uncompleted: no revert button yet
    expect(doc.querySelector(".revert-link")).toBeNull();

    // Sparse completion update (omits content and rawInput, like claude-agent-acp):
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc5", status: "completed" },
    });

    const button = doc.querySelector(".revert-link") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("revert edit");
    expect(button.disabled).toBe(false);

    click(window, button);
    expect(button.disabled).toBe(true);
    const sent = posted.filter((m: any) => m.type === "revertToolEdit");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      toolCallId: "tc5",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
    });
  });
});

