// DOM-level regression tests for issue #37: "Tool calls hang on Thinking… then
// resolve as cancelled with empty result (no confirm prompt)".
//
// Two webview bugs conspired to cancel in-flight turns without the user ever
// clicking Stop:
//
//   1. Enter was bound to sendOrStop() unconditionally, so typing a follow-up
//      ("continue") during a long turn and pressing Enter posted {type:"cancel"}
//      — the CLI logged shell.cancel.received and resolved the running tools as
//      "Tool execution was cancelled by the user (tool … was not executed)".
//   2. state.busy leaked across session swaps: resetForNewSession() never reset
//      it and replayed agentStart never set it, so with several dashboard
//      sessions the send button could show Stop on an idle session (Enter =
//      phantom cancel) or the send arrow on a working one (Enter = second
//      session/prompt mid-turn, which kills the in-flight turn CLI-side).
//
// The fix (Claude-style): typed text NEVER cancels — Enter and the button click
// both queue the message. The queue is HOST-owned per session (like chips): the
// webview posts queueSend/dequeueSend/clearQueuedSends, renders pending user
// blocks from the queuedSends snapshot (so queued messages survive focus
// switches), and the HOST flushes the queue as one combined prompt when the
// session's turn ends — even while backgrounded. Busy itself is event-sourced
// through the session buffer (agentStart sets it, agentEnd/agentError/exit
// clear it, clearMessages resets it).
import { describe, it, expect } from "vitest";
import { bootWebview as bootRawWebview, dispatch, click, press, Posted } from "./webview-harness";

function bootWebview(opts: Parameters<typeof bootRawWebview>[0] = {}) {
  const harness = bootRawWebview(opts);
  if (opts.ready !== false) {
    dispatch(harness.window, { type: "initialized", info: { provider: "grok", steeringSupported: true, init: {} } });
  }
  return harness;
}

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const types = (posted: Posted[]) => posted.map((p) => p.type);
const queuedBlocks = (doc: Document) =>
  [...doc.querySelectorAll(".msg.queued .queued-text")].map((e) => e.textContent);

function pressEnter(window: any, inputEl: Element): void {
  inputEl.dispatchEvent(
    new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

/** Simulate the host bouncing back its queue snapshot (the webview is a mirror). */
function seedQueue(window: any, items: string[]): void {
  dispatch(window, { type: "queuedSends", items });
}

describe("Enter while busy queues instead of cancelling (#37)", () => {
  it("never posts cancel from the keyboard; the typed message goes to the host queue", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    dispatch(window, { type: "setBusy", value: true }); // stoppable turn in flight
    input.value = "continue";
    pressEnter(window, input);

    // The old behavior posted {type:"cancel"} here — the reporter's phantom cancel.
    expect(types(posted)).not.toContain("cancel");
    expect(types(posted)).not.toContain("send");
    const q = posted.find((p) => p.type === "queueSend");
    expect(q?.text).toBe("continue");
    expect(input.value).toBe(""); // handed to the queue, composer cleared

    // Host bounces the snapshot → a pending block renders at the end of the chat.
    seedQueue(window, ["continue"]);
    expect(queuedBlocks(doc)).toEqual(["continue"]);
  });

  it("Enter during the startup spinner (busy+locked) type-ahead-queues, never cancels", () => {
    // The send button is disabled while busyLocked, but Enter bypasses a
    // disabled button — before the fix it posted a cancel into the startup
    // window. The HOST flushes the queue once the primer acks.
    const { window, posted, doc } = bootWebview({ ready: false }); // boot state: busy + locked
    const input = $(doc, "input") as HTMLTextAreaElement;

    input.value = "first prompt";
    pressEnter(window, input);

    expect(types(posted)).not.toContain("cancel");
    expect(types(posted)).not.toContain("send");
    expect((posted.find((p) => p.type === "queueSend"))?.text).toBe("first prompt");
  });

  it("Enter with an empty composer while busy does nothing (no cancel, no send, no queue)", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });

    pressEnter(window, $(doc, "input"));

    expect(posted.filter((p) => ["cancel", "send", "queueSend"].includes(p.type))).toEqual([]);
  });

  it("clicking the square Stop button with an EMPTY composer still cancels — stopping stays explicit", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });

    const sendBtn = $(doc, "send-btn");
    expect(sendBtn.classList.contains("stop")).toBe(true);
    click(window, sendBtn);

    expect(types(posted)).toContain("cancel");
  });

  it("the ambient editor chip is not send-intent — a busy composer stays Stop", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "implicit:/repo/a.ts",
        path: "/repo/a.ts",
        relPath: "a.ts",
        hidden: false,
      }],
    });
    expect($(doc, "send-btn").classList.contains("stop")).toBe(true);
  });

  it("clicking the button while busy WITH typed text queues — text present never cancels (Claude model)", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    dispatch(window, { type: "setBusy", value: true });

    input.value = "follow-up";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    // With text typed the button face is the send arrow, not the square.
    const sendBtn = $(doc, "send-btn");
    expect(sendBtn.classList.contains("stop")).toBe(false);

    click(window, sendBtn);
    expect(types(posted)).not.toContain("cancel");
    expect(types(posted)).not.toContain("send");
    expect((posted.find((p) => p.type === "queueSend"))?.text).toBe("follow-up");
    expect(input.value).toBe("");
    // Composer emptied by the queue → the button face returns to Stop.
    expect(sendBtn.classList.contains("stop")).toBe(true);
  });

  it("the busy button face follows the composer: typing flips Stop → send arrow, clearing flips back", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    const sendBtn = $(doc, "send-btn");
    dispatch(window, { type: "setBusy", value: true });

    expect(sendBtn.classList.contains("stop")).toBe(true);

    input.value = "typing…";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect(sendBtn.classList.contains("stop")).toBe(false);

    input.value = "";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    expect(sendBtn.classList.contains("stop")).toBe(true);
  });

  it("whitespace-only input counts as empty: face stays Stop and the click cancels", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    const sendBtn = $(doc, "send-btn");
    dispatch(window, { type: "setBusy", value: true });

    input.value = "   ";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    expect(sendBtn.classList.contains("stop")).toBe(true); // no send-intent in whitespace
    click(window, sendBtn);
    expect(types(posted)).toContain("cancel");
    expect(types(posted)).not.toContain("queueSend");
  });

  it("an image-only composer while busy is Queue, never Stop — click does not cancel", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "9.9.9",
      showThinking: false, expandCommandOutputs: false, steerByDefault: false,
      capabilities: { uploadFile: true, remoteVoice: true, queueSendChips: true },
    });
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/s/a.png:1:1",
        path: "/s/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
      }],
    });

    const sendBtn = $(doc, "send-btn");
    expect(sendBtn.classList.contains("stop")).toBe(false);
    expect(sendBtn.title).toMatch(/Queue/);

    click(window, sendBtn);
    expect(types(posted)).not.toContain("cancel");
    expect(types(posted)).not.toContain("send");
    expect(posted.find((p) => p.type === "queueSend")).toMatchObject({
      type: "queueSend",
      text: "",
      chips: [expect.objectContaining({ id: "image:/s/a.png:1:1" })],
    });
  });

  it("image-only + Enter queues instead of no-op, and never cancels", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "9.9.9",
      showThinking: false, expandCommandOutputs: false, steerByDefault: false,
      capabilities: { uploadFile: true, remoteVoice: true, queueSendChips: true },
    });
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/s/a.png:1:1",
        path: "/s/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
      }],
    });

    pressEnter(window, $(doc, "input"));
    expect(types(posted)).not.toContain("cancel");
    expect(posted.find((p) => p.type === "queueSend")).toMatchObject({ text: "", chips: expect.any(Array) });
  });

  it("without queueSendChips, attachments refuse to queue rather than drop, and still do not cancel", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/s/a.png:1:1",
        path: "/s/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
      }],
    });

    click(window, $(doc, "send-btn"));
    expect(types(posted)).not.toContain("cancel");
    expect(types(posted)).not.toContain("queueSend");
    expect(doc.querySelector(".msg.error")?.textContent).toMatch(/cannot queue attachments/);
  });

  it("after the turn ends the button returns to a plain Send", () => {
    const { window, doc } = bootWebview();
    const sendBtn = $(doc, "send-btn") as HTMLButtonElement;
    dispatch(window, { type: "setBusy", value: true });
    expect(sendBtn.classList.contains("stop")).toBe(true);

    dispatch(window, { type: "agentEnd" });

    expect(sendBtn.classList.contains("stop")).toBe(false);
    expect(sendBtn.title).toBe("Send");
    expect(sendBtn.disabled).toBe(false);
  });
});

describe("queued blocks — host-owned per session (#37)", () => {
  it("renders ONE pending block (the host keeps a single appended message), full text on hover, cleared on an empty snapshot", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });

    // The host appends follow-ups into the single entry (blank-line separated —
    // the exact flush format), so the block previews what will actually send.
    seedQueue(window, ["first message\n\nsecond message"]);
    expect(queuedBlocks(doc)).toEqual(["first message\n\nsecond message"]);
    expect(doc.querySelectorAll(".msg.queued").length).toBe(1); // never separate entries
    const body = doc.querySelector(".msg.queued .queued-text") as HTMLElement;
    expect(body.title).toBe("first message\n\nsecond message"); // clamped body → full text in tooltip

    seedQueue(window, []); // host flushed (or cleared) the queue
    expect(queuedBlocks(doc)).toEqual([]);
  });

  it("renders chips from additive queued entries so two contributions keep their own attachments", () => {
    const { window, doc } = bootWebview();
    const chipA = {
      id: "image:/s/a.png:1:1", path: "/s/a.png", relPath: "Image #1",
      hidden: false, imageIndex: 1, mimeType: "image/png",
    };
    const chipB = {
      id: "image:/s/b.png:1:2", path: "/s/b.png", relPath: "Image #2",
      hidden: false, imageIndex: 2, mimeType: "image/png",
    };
    dispatch(window, {
      type: "queuedSends",
      items: ["look at A", "and B"],
      queued: [
        { text: "look at A", chips: [chipA] },
        { text: "and B", chips: [chipB] },
      ],
    });
    expect(queuedBlocks(doc)).toEqual(["look at A\n\nand B"]);
    const chipLabels = [...doc.querySelectorAll(".msg.queued .msg-chip")].map((el) => el.textContent);
    expect(chipLabels).toEqual(["Image #1", "Image #2"]);
  });

  it("a surviving queued chip keeps #2 after the earlier contribution is gone", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "queuedSends",
      items: ["edit [Image #2]"],
      queued: [{
        text: "edit [Image #2]",
        chips: [{
          id: "image:/s/b.png:2:2", path: "/s/b.png", relPath: "Image #2",
          hidden: false, imageIndex: 2, mimeType: "image/png",
        }],
      }],
    });
    expect(queuedBlocks(doc)).toEqual(["edit [Image #2]"]);
    expect(doc.querySelector(".msg.queued .msg-chip")?.textContent).toBe("Image #2");
  });

  it("Edit hands the WHOLE pending message back to the composer (before any draft) and dequeues it", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    dispatch(window, { type: "setBusy", value: true });
    seedQueue(window, ["fix the test\n\nand rerun"]);

    input.value = "half-typed draft";
    const editBtn = doc.querySelector('.queued-action[title^="Edit"]') as HTMLElement;
    press(window, editBtn);

    expect(posted.find((p) => p.type === "clearQueuedSends")).toEqual({
      type: "clearQueuedSends",
      restore: true,
    });
    // Queued text is older than the current draft → it goes first.
    expect(input.value).toBe("fix the test\n\nand rerun\n\nhalf-typed draft");

    // Host confirms the removal with a fresh snapshot.
    seedQueue(window, []);
    expect(queuedBlocks(doc)).toEqual([]);
  });

  it("Remove drops the pending message", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });
    seedQueue(window, ["drop me"]);

    const removeBtn = doc.querySelector('.queued-action[title="Remove from queue"]') as HTMLElement;
    press(window, removeBtn);

    expect(posted.find((p) => p.type === "clearQueuedSends")).toEqual({ type: "clearQueuedSends" });
  });

  it("clicking Stop with messages queued hands them back to the composer and clears the host queue BEFORE cancelling", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    const sendBtn = $(doc, "send-btn");
    dispatch(window, { type: "setBusy", value: true });
    seedQueue(window, ["continue\n\nand also this"]); // host keeps ONE appended entry
    expect(sendBtn.classList.contains("stop")).toBe(true); // composer is empty → Stop face

    click(window, sendBtn); // halt

    // Queued text is returned for editing/re-sending, not auto-fired.
    expect(input.value).toBe("continue\n\nand also this");
    expect(queuedBlocks(doc)).toEqual([]);
    // The host must empty its queue before the cancel settles the turn —
    // message order on the channel guarantees it.
    const clearIdx = posted.findIndex((p) => p.type === "clearQueuedSends");
    const cancelIdx = posted.findIndex((p) => p.type === "cancel");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(clearIdx);
  });

  it("a session swap wipes the blocks locally but never clears the host queue; the replay snapshot rebuilds them", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, { type: "setBusy", value: true });
    seedQueue(window, ["mine, session A"]);
    expect(queuedBlocks(doc)).toEqual(["mine, session A"]);

    dispatch(window, { type: "clearMessages" }); // focus swap
    expect(queuedBlocks(doc)).toEqual([]);
    // The queue belongs to session A on the HOST — swapping focus must not touch it.
    expect(types(posted)).not.toContain("clearQueuedSends");

    // Swapping back: the buffer replay delivers A's snapshot again.
    seedQueue(window, ["mine, session A"]);
    expect(queuedBlocks(doc)).toEqual(["mine, session A"]);
  });

  it("provider sign-out returns the doomed queue to the replacement composer without losing text typed during reset", () => {
    const { window, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    seedQueue(window, ["queued before sign-out"]);

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "restoreComposer", text: "queued before sign-out" });
    input.value += "\n\ntyped during remote resets";

    expect(queuedBlocks(doc)).toEqual([]);
    expect(input.value).toBe("queued before sign-out\n\ntyped during remote resets");
  });
});

describe("busy state does not leak across session swaps (#37)", () => {
  it("swapping away from a working session resets busy — Enter on the idle session sends, not cancels", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    dispatch(window, { type: "setBusy", value: true }); // session A mid-turn
    dispatch(window, { type: "clearMessages" }); // focus swap to idle session B (empty buffer)

    input.value = "hi";
    pressEnter(window, input);

    // Before the fix, the stale Stop state turned this Enter into a cancel.
    expect(types(posted)).not.toContain("cancel");
    expect((posted.find((p) => p.type === "send"))?.text).toBe("hi");
  });

  it("replaying a mid-turn session restores busy — Enter queues instead of double-prompting", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    // Focus swap onto a working session: buffer replays its turn-in-flight tail.
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "userMessage", text: "do the thing" });
    dispatch(window, { type: "agentStart" });

    expect($(doc, "send-btn").classList.contains("stop")).toBe(true);

    input.value = "continue";
    pressEnter(window, input);

    // Before the fix busy was stale-false here, so this posted a second
    // {type:"send"} mid-turn — the CLI resolves that by killing the running turn.
    expect(types(posted)).not.toContain("send");
    expect((posted.find((p) => p.type === "queueSend"))?.text).toBe("continue");
  });

  it("replaying a finished turn ends idle — agentEnd wins over agentStart", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "userMessage", text: "done already" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "agentEnd" });

    expect($(doc, "send-btn").classList.contains("stop")).toBe(false);
    input.value = "next task";
    pressEnter(window, input);
    expect((posted.find((p) => p.type === "send"))?.text).toBe("next task");
  });
});

describe("IME composition: Enter mid-composition never sends or queues (#38)", () => {
  const composingEnter = (window: any, extra: Record<string, unknown> = {}) =>
    new (window as any).KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, ...extra,
    });

  it("Enter with isComposing confirms the IME candidate only — no send, text stays put", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    input.value = "半角"; // mid-composition preedit
    input.dispatchEvent(composingEnter(window, { isComposing: true }));

    expect(types(posted)).not.toContain("send");
    expect(input.value).toBe("半角"); // untouched — the IME owns this Enter
  });

  it("Enter with the legacy keyCode 229 is also ignored", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    input.value = "注音";
    const e = composingEnter(window);
    Object.defineProperty(e, "keyCode", { value: 229 });
    input.dispatchEvent(e);

    expect(types(posted)).not.toContain("send");
    expect(input.value).toBe("注音");
  });

  it("Enter mid-composition while busy does not queue a half-composed fragment", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;
    dispatch(window, { type: "setBusy", value: true });

    input.value = "中文片";
    input.dispatchEvent(composingEnter(window, { isComposing: true }));

    expect(types(posted)).not.toContain("queueSend");
    expect(types(posted)).not.toContain("cancel");
    expect(input.value).toBe("中文片");
  });

  it("a plain Enter after composition ends still sends", () => {
    const { window, posted, doc } = bootWebview();
    const input = $(doc, "input") as HTMLTextAreaElement;

    input.value = "中文訊息";
    pressEnter(window, input); // isComposing defaults false

    expect((posted.find((p) => p.type === "send"))?.text).toBe("中文訊息");
  });
});

describe("the locked startup/priming window has no cancel at all (#37)", () => {
  it("shows a disabled spinner, and a click cannot cancel", () => {
    const { window, posted, doc } = bootWebview({ ready: false }); // boot state: busy + locked
    const sendBtn = $(doc, "send-btn") as HTMLButtonElement;

    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.classList.contains("initializing")).toBe(true);
    expect(sendBtn.classList.contains("stop")).toBe(false);

    click(window, sendBtn); // even a programmatic click must not cancel
    expect(types(posted)).not.toContain("cancel");
  });

  it("typing during the locked window keeps the spinner (locked wins over text)", () => {
    const { window, doc } = bootWebview({ ready: false });
    const input = $(doc, "input") as HTMLTextAreaElement;
    const sendBtn = $(doc, "send-btn") as HTMLButtonElement;

    input.value = "typed while starting";
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    expect(sendBtn.classList.contains("initializing")).toBe(true);
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.classList.contains("stop")).toBe(false);
  });
});

// Steer (#52) — the queue's sibling. A queued message waits for the turn to end;
// steering injects it into the RUNNING turn via grok's `_x.ai/interject`, which
// queues into a buffer the agent drains at its next safe point. It does NOT
// cancel: probed live on 0.2.101, the model changed course mid-stream and the
// turn still ended `end_turn`, losing no in-flight tool work.
describe("Steer — submit into the running turn (#52)", () => {
  const steerBtn = (doc: Document) => doc.querySelector(".queued-steer") as HTMLButtonElement | null;

  it("steering posts steerSend and drops the message from the queue — never cancel", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "agentStart" });
    seedQueue(window, ["actually, use async"]);

    press(window, steerBtn(doc)!);

    expect(types(posted)).toContain("steerSend");
    expect(posted.find((p) => p.type === "steerSend")).toMatchObject({
      text: "actually, use async",
      fromQueue: true,
    });
    // The whole point of #52: steering is not a disguised Stop.
    expect(types(posted)).not.toContain("cancel");
    // It leaves the queue, or the host would ALSO flush it at turn end (double send).
    expect(types(posted)).toContain("clearQueuedSends");
    expect(types(posted).indexOf("steerSend")).toBeLessThan(types(posted).indexOf("clearQueuedSends"));
  });

  it("offers Steer when the queued item has an attachment and carries those chips", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "agentStart" });
    const chip = {
      id: "image:/s/a.png:1:1", path: "/s/a.png", relPath: "Image #1",
      hidden: false, imageIndex: 1, mimeType: "image/png",
    };
    dispatch(window, {
      type: "queuedSends",
      items: ["look at this"],
      queued: [{ text: "look at this", chips: [chip] }],
    });

    expect(steerBtn(doc)).not.toBeNull();
    press(window, steerBtn(doc)!);
    expect(posted.find((p) => p.type === "steerSend")).toMatchObject({
      type: "steerSend",
      text: "look at this",
      fromQueue: true,
      chips: [expect.objectContaining({ id: chip.id })],
    });
    expect(types(posted)).not.toContain("cancel");
  });

  it("renders queued chips below queued text, matching a sent user bubble", () => {
    const { window, doc } = bootWebview();
    const chip = {
      id: "image:/s/a.png:1:1", path: "/s/a.png", relPath: "Image #1",
      hidden: false, imageIndex: 1, mimeType: "image/png",
    };
    dispatch(window, {
      type: "queuedSends",
      items: ["look at this"],
      queued: [{ text: "look at this", chips: [chip] }],
    });
    const bubble = doc.querySelector(".msg.queued .msg-bubble") as HTMLElement;
    const classes = [...bubble.children].map((el) => el.className);
    expect(classes).toEqual(["queued-hdr", "queued-text", "msg-chips"]);
    expect(bubble.querySelector(".msg-chip")?.textContent).toBe("Image #1");
    expect(bubble.querySelector(".queued-text")?.textContent).toBe("look at this");
  });

  it("is hidden when no turn is running — there is nothing to steer", () => {
    const { window, doc } = bootWebview();
    seedQueue(window, ["later"]);
    // Rendered but not visible: `body.turn-busy` gates it, so a replay ordering
    // queuedSends before agentStart still lands the button once busy arrives.
    expect(doc.body.classList.contains("turn-busy")).toBe(false);

    dispatch(window, { type: "agentStart" });
    expect(doc.body.classList.contains("turn-busy")).toBe(true);
    expect(steerBtn(doc)).not.toBeNull();

    dispatch(window, { type: "agentEnd" });
    expect(doc.body.classList.contains("turn-busy")).toBe(false);
  });

  it("an older CLI (steerUnavailable) hides Steer and leaves the queue working", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    seedQueue(window, ["hello"]);
    expect(steerBtn(doc)).not.toBeNull();

    // Host latches it off after `_x.ai/interject` answered -32601.
    dispatch(window, { type: "steerUnavailable" });
    expect(steerBtn(doc)).toBeNull();
    // The queued block itself must survive — the text is the fallback's payload.
    expect(queuedBlocks(doc)).toEqual(["hello"]);
  });
});

// The queued block is appended to the END of the chat and every streamed chunk
// runs scrollToBottom, so the block slides under the cursor while the agent
// writes prose. A `click` needs mousedown AND mouseup on the same element, so
// steering mid-stream was a coin flip (fine during a tool call — nothing
// reflows then). The actions bind pointerdown, which fires on press.
describe("queued-block actions survive mid-stream reflow (#52)", () => {
  it("Steer/Edit/Remove act on pointerdown, not click", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "agentStart" });
    seedQueue(window, ["steer me"]);

    // A bare click must not be what the feature depends on.
    click(window, doc.querySelector(".queued-steer") as HTMLElement);
    expect(types(posted)).not.toContain("steerSend");

    press(window, doc.querySelector(".queued-steer") as HTMLElement);
    expect(types(posted)).toContain("steerSend");
  });
});

// grok.steerByDefault (#52): flips send-while-busy from "wait for the turn" to
// "go in now". False by default — today's queueing behavior is the safe one.
describe("Steer by default — skip the queue (#52)", () => {
  const typeAndEnter = (window: any, doc: Document, text: string) => {
    const input = $(doc, "input") as HTMLTextAreaElement;
    input.value = text;
    pressEnter(window, input);
  };

  it("queues by default — the setting is off unless asked for", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "agentStart" });
    typeAndEnter(window, doc, "follow-up");
    expect(types(posted)).toContain("queueSend");
    expect(types(posted)).not.toContain("steerSend");
  });

  it("steers instead of queueing when enabled", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "steerByDefault", value: true });
    dispatch(window, { type: "agentStart" });
    typeAndEnter(window, doc, "use async instead");
    expect(types(posted)).toContain("steerSend");
    expect(types(posted)).not.toContain("queueSend");
    // Still never a cancel — steering is not a disguised Stop.
    expect(types(posted)).not.toContain("cancel");
  });

  it("steers an attachment instead of hiding Steer or dropping the file", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "9.9.9",
      showThinking: false, expandCommandOutputs: false, steerByDefault: true,
      capabilities: { uploadFile: true, remoteVoice: true, queueSendChips: true },
    });
    dispatch(window, { type: "agentStart" });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/s/a.png:1:1",
        path: "/s/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
      }],
    });
    typeAndEnter(window, doc, "what is this");
    expect(posted.find((p) => p.type === "steerSend")).toMatchObject({
      type: "steerSend",
      text: "what is this",
      chips: [expect.objectContaining({ id: "image:/s/a.png:1:1" })],
    });
    expect(types(posted)).not.toContain("queueSend");
  });

  it("falls back to the queue during the locked startup window", () => {
    // busy+locked = priming: there's no live turn to interject into yet, so the
    // message must wait rather than fail.
    const { window, doc, posted } = bootWebview({ ready: false });
    dispatch(window, { type: "steerByDefault", value: true });
    typeAndEnter(window, doc, "too early");
    expect(types(posted)).not.toContain("steerSend");
  });

  it("falls back to the queue when the CLI can't interject", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "steerByDefault", value: true });
    dispatch(window, { type: "steerUnavailable" }); // older CLI: -32601
    dispatch(window, { type: "agentStart" });
    typeAndEnter(window, doc, "hello");
    // A capability gap must degrade to queueing, not fail every single send.
    expect(types(posted)).toContain("queueSend");
    expect(types(posted)).not.toContain("steerSend");
  });

  it("initialState carries the persisted setting", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "1.6.2",
      showThinking: false, expandCommandOutputs: false, steerByDefault: true,
    });
    dispatch(window, { type: "agentStart" });
    typeAndEnter(window, doc, "x");
    expect(types(posted)).toContain("steerSend");
  });
});
